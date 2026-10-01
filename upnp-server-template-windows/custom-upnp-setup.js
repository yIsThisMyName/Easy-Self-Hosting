import dgram from "node:dgram";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import { XMLParser } from "fast-xml-parser";

const MULTICAST_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
// const PORT = 8080; // this might be changed later, currently hardcoded
// const SERVER_NAME = "y's test server template"; // this will also probably be changed

function getNetworkInterfaces() {
    const interfaces = [];

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
        for (const info of addresses ?? []) {
            if (
                info.family === "IPv4" &&
                !info.internal &&
                !info.address.startsWith("169.254.")
            ) {
                interfaces.push({
                    name,
                    address: info.address
                });
            }
        }
    }

    return interfaces;
}

function parseHeaders(message) {
    const headers = {};

    const lines = message.split(/\r?\n/);

    for (const line of lines) {
        const separator = line.indexOf(":");

        if (separator === -1) {
            continue;
        }

        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();

        headers[name] = value;
    }

    return headers;
}

function isGatewayResponse(headers) {
    const st = headers["st"] ?? "";
    const usn = headers["usn"] ?? "";

    return (
        st.includes("InternetGatewayDevice") ||
        st.includes("WANIPConnection") ||
        st.includes("WANPPPConnection") ||
        usn.includes("InternetGatewayDevice") ||
        usn.includes("WANIPConnection") ||
        usn.includes("WANPPPConnection")
    );
}

async function getGatewayLocation() {
    const networkInterfaces = getNetworkInterfaces();

    const searchMessage =
        `M-SEARCH * HTTP/1.1\r\n` +
        `HOST: ${MULTICAST_ADDRESS}:${SSDP_PORT}\r\n` +
        `MAN: "ssdp:discover"\r\n` +
        `MX: 2\r\n` +
        `ST: ssdp:all\r\n` +
        `\r\n`;

    return new Promise((resolve, reject) => {
        const sockets = [];
        let finished = false;

        function finish(result, error = null) {
            if (finished) {
                return;
            }

            finished = true;

            for (const socket of sockets) {
                try {
                    socket.close();
                } catch {}
            }

            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        }

        for (const networkInterface of networkInterfaces) {
            const socket = dgram.createSocket("udp4");

            sockets.push(socket);

            socket.on("error", error => {
                console.log(
                    `SSDP error on ${networkInterface.name}:`,
                    error.message
                );
            });

            socket.on("message", message => {
                const text = message.toString();
                const headers = parseHeaders(text);

                if (!isGatewayResponse(headers)) {
                    return;
                }

                const location = headers["location"];

                if (!location) {
                    return;
                }

                finish({
                    location,
                    localAddress: networkInterface.address
                });
            });

            socket.bind(0, networkInterface.address, () => {
                socket.setMulticastInterface(networkInterface.address);

                socket.send(
                    Buffer.from(searchMessage),
                    SSDP_PORT,
                    MULTICAST_ADDRESS,
                    error => {
                        if (error) {
                            console.log(
                                `Failed to search on ${networkInterface.name}:`,
                                error.message
                            );
                        }
                    }
                );
            });
        }

        // Don't wait forever if no gateway responds.
        setTimeout(() => {
            finish(null);
        }, 5000);
    });
}
function fetchURL(location) {
    return new Promise((resolve, reject) => {
        const client = location.startsWith("https:")
            ? https
            : http;

        const request = client.get(location, response => {
            let data = "";

            response.setEncoding("utf8");

            response.on("data", chunk => {
                data += chunk;
            });

            response.on("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(
                        new Error(
                            `HTTP request failed with status ${response.statusCode}`
                        )
                    );
                    return;
                }

                resolve(data);
            });
        });

        request.on("error", reject);

        request.setTimeout(5000, () => {
            request.destroy(
                new Error("Request timed out")
            );
        });
    });
}
function findWANIPConnectionService(xml) {
    const parser = new XMLParser({
        ignoreAttributes: false
    });

    const document = parser.parse(xml);

    // We'll recursively search every device/service in the XML.
    function search(object) {
        if (!object || typeof object !== "object") {
            return null;
        }

        // Check whether this object represents a service.
        if (object.serviceType) {
            const serviceType = object.serviceType;

            if (
                typeof serviceType === "string" &&
                serviceType.includes(":service:WANIPConnection:")
            ) {
                return object;
            }
        }

        // Search everything underneath this object.
        for (const value of Object.values(object)) {
            const result = search(value);

            if (result) {
                return result;
            }
        }

        return null;
    }

    return search(document);
}
function findAction(scpd, actionName) {
    const actions = scpd?.scpd?.actionList?.action;

    if (!actions) {
        return null;
    }

    const actionArray = Array.isArray(actions)
        ? actions
        : [actions];

    return actionArray.find(
        action => action.name === actionName
    ) ?? null;
}
function getActionArguments(action) {
    const argumentsList = action?.argumentList?.argument;

    if (!argumentsList) {
        return [];
    }

    return Array.isArray(argumentsList)
        ? argumentsList
        : [argumentsList];
}
function createSOAPRequest(
    serviceType,
    actionName,
    argumentsList = {}
) {
    const bodyArguments = Object.entries(argumentsList)
        .map(([name, value]) =>
            `<${name}>${escapeXML(value)}</${name}>`
        )
        .join("");

    return (
        `<?xml version="1.0"?>` +
        `<s:Envelope ` +
        `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
        `<s:Body>` +
        `<u:${actionName} xmlns:u="${escapeXML(serviceType)}">` +
        bodyArguments +
        `</u:${actionName}>` +
        `</s:Body>` +
        `</s:Envelope>`
    );
}
async function callUPnPAction(
    controlURL,
    serviceType,
    actionName,
    argumentsList = {}
) {
    const soapBody = createSOAPRequest(
        serviceType,
        actionName,
        argumentsList
    );

    const response = await fetch(controlURL, {
        method: "POST",

        headers: {
            "Content-Type": "text/xml; charset=\"utf-8\"",
            "SOAPAction": `"${serviceType}#${actionName}"`
        },

        body: soapBody
    });

    const responseText = await response.text();

    if (!response.ok && response.status !== 500) {
        throw new Error(
            `UPnP action failed: HTTP ${response.status}\n${responseText}`
        );
    }

    return responseText;
}
function parseSOAPResponse(xml, responseElement) {
    const parser = new XMLParser({
        ignoreAttributes: false
    });

    const document = parser.parse(xml);

    function findByLocalName(object, localName) {
        if (!object || typeof object !== "object") {
            return null;
        }

        for (const [key, value] of Object.entries(object)) {
            const keyLocalName = key.includes(":")
                ? key.split(":").pop()
                : key;

            if (keyLocalName === localName) {
                return value;
            }
        }

        return null;
    }

    const envelope = findByLocalName(document, "Envelope");

    if (!envelope) {
        throw new Error(
            "Invalid SOAP response: SOAP Envelope not found."
        );
    }

    const body = findByLocalName(envelope, "Body");

    if (!body) {
        throw new Error(
            "Invalid SOAP response: SOAP Body not found."
        );
    }

    const fault = findByLocalName(body, "Fault");

    if (fault) {
        const faultCode =
            findByLocalName(fault, "faultcode") ??
            "Unknown";

        const faultString =
            findByLocalName(fault, "faultstring") ??
            "Unknown SOAP fault";

        const detail = findByLocalName(fault, "detail");

        const upnpError =
            findByLocalName(detail, "UPnPError");

        let errorMessage =
            `UPnP SOAP Fault: ${faultString} (${faultCode})`;

        if (upnpError) {
            const errorCode =
                findByLocalName(upnpError, "errorCode");

            const errorDescription =
                findByLocalName(upnpError, "errorDescription");

            if (errorCode || errorDescription) {
                errorMessage +=
                    `\nUPnP error code: ${errorCode ?? "Unknown"}` +
                    `\nUPnP error description: ${errorDescription ?? "Unknown"}`;
            }
        }

        throw new Error(errorMessage);
    }

    const responseName = responseElement.includes(":")
        ? responseElement.split(":").pop()
        : responseElement;

    const response = findByLocalName(body, responseName);

    if (!response) {
        throw new Error(
            `SOAP response element "${responseName}" was not found.`
        );
    }

    return response;
}
function escapeXML(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
async function getPortMapping(
    controlURL,
    serviceType,
    externalPort,
    protocol
) {
    try {
        const response = await callUPnPAction(
            controlURL,
            serviceType,
            "GetSpecificPortMappingEntry",
            {
                NewRemoteHost: "",
                NewExternalPort: externalPort,
                NewProtocol: protocol
            }
        );

        return parseSOAPResponse(
            response,
            "u:GetSpecificPortMappingEntryResponse",
            null
        );
    } catch (error) {
        return null;
    }
}
function isNoSuchMappingError(error) {
    return error.message.includes("UPnP error code: 714");
}
async function getExistingPortMapping(
    controlURL,
    serviceType,
    port
) {
    try {
        const response = await callUPnPAction(
            controlURL,
            serviceType,
            "GetSpecificPortMappingEntry",
            {
                NewRemoteHost: "",
                NewExternalPort: port,
                NewProtocol: "TCP"
            }
        );

        return parseSOAPResponse(
            response,
            "u:GetSpecificPortMappingEntryResponse"
        );

    } catch (error) {
        if (isNoSuchMappingError(error)) {
            return null;
        }

        throw error;
    }
}
async function ensurePortMapping(
    controlURL,
    serviceType,
    port,
    localIP,
    addPortMapping,
    deletePortMapping,
    serverName
) {
    if (!addPortMapping) {
        throw new Error("AddPortMapping is not supported.");
    }

    if (!deletePortMapping) {
        throw new Error("DeletePortMapping is not supported.");
    }

    const mappingArguments = {
        NewRemoteHost: "",
        NewExternalPort: port,
        NewProtocol: "TCP",
        NewInternalPort: port,
        NewInternalClient: localIP,
        NewEnabled: "1",
        NewPortMappingDescription: serverName,
        NewLeaseDuration: 0
    };

    const existingMapping = await getExistingPortMapping(
        controlURL,
        serviceType,
        port
    );

    if (existingMapping) {
        console.log("Existing port mapping found:");
        console.log(existingMapping.NewPortMappingDescription);
    } else {
        console.log("No existing port mapping found.");
    }

    // No mapping exists, so create one
    if (!existingMapping) {
        console.log("Creating port mapping...");

        await callUPnPAction(
            controlURL,
            serviceType,
            "AddPortMapping",
            mappingArguments
        );

        console.log("Port mapping created.");
        return;
    }

    console.log(
        `Existing port mapping points to ${existingMapping.NewInternalClient}.`
    );

    console.log("Removing existing port mapping...");

    await callUPnPAction(
        controlURL,
        serviceType,
        "DeletePortMapping",
        {
            NewRemoteHost: "",
            NewExternalPort: port,
            NewProtocol: "TCP"
        }
    );

    console.log("Existing port mapping removed.");
    console.log("Creating new port mapping...");

    await callUPnPAction(
        controlURL,
        serviceType,
        "AddPortMapping",
        mappingArguments
    );

    console.log("New port mapping created.");
}
function validateActionArguments(action, requiredArguments) {
    if (!action) {
        throw new Error("Cannot validate arguments: action was not found.");
    }

    const argumentsList = getActionArguments(action);

    for (const requiredArgument of requiredArguments) {
        const foundArgument = argumentsList.find(
            argument => argument.name === requiredArgument
        );

        if (!foundArgument) {
            throw new Error(
                `Action "${action.name}" is missing required argument "${requiredArgument}".`
            );
        }

        if (foundArgument.direction !== "in") {
            throw new Error(
                `Action "${action.name}" argument "${requiredArgument}" is not an input argument.`
            );
        }
    }

    return true;
}





export async function setupUPnP(serverName,port) {
    const gateway = await getGatewayLocation();

    if (!gateway) {
        throw new Error("No UPnP gateway found.");
    }

    const location = gateway.location;
    const localIP = gateway.localAddress;

    if (!location) {
        console.log("No UPnP gateway found.");
        process.exit(1);
    }

    try {
        const description = await fetchURL(location);

        const service = findWANIPConnectionService(description);

        if (!service) {
            console.log("No WANIPConnection service found.");
        }

        const controlURL = new URL(
            service.controlURL,
            location
        ).href;

        const scpdURL = new URL(
            service.SCPDURL,
            location
        ).href;

        const scpdXML = await fetchURL(scpdURL);
        const parser = new XMLParser({
            ignoreAttributes: false
        });

        const scpd = parser.parse(scpdXML);

        const addPortMapping = findAction(
            scpd,
            "AddPortMapping"
        );

        validateActionArguments(
            addPortMapping,
            [
                "NewRemoteHost",
                "NewExternalPort",
                "NewProtocol",
                "NewInternalPort",
                "NewInternalClient",
                "NewEnabled",
                "NewPortMappingDescription",
                "NewLeaseDuration"
            ]
        );

        const deletePortMapping = findAction(
            scpd,
            "DeletePortMapping"
        );

        validateActionArguments(
            deletePortMapping,
            [
                "NewRemoteHost",
                "NewExternalPort",
                "NewProtocol"
            ]
        );

        const getExternalIP = findAction(
            scpd,
            "GetExternalIPAddress"
        );

        if (!getExternalIP) {
            console.log(
                "Router does not advertise GetExternalIPAddress."
            );
            process.exit(1);
        }

        try {
            const response = await callUPnPAction(
                controlURL,
                service.serviceType,
                "GetExternalIPAddress"
            );

            const externalIPResponse = parseSOAPResponse(
                response,
                "u:GetExternalIPAddressResponse"
            );

            const externalIP = externalIPResponse.NewExternalIPAddress;

            const gateway = await getGatewayLocation();
            const localIP = gateway.localAddress;

            if (!localIP) {
                throw new Error("Could not determine local IPv4 address.");
            }

            const mappingArguments = {
                NewRemoteHost: "",
                NewExternalPort: port,
                NewProtocol: "TCP",
                NewInternalPort: port,
                NewInternalClient: localIP,
                NewEnabled: "1",
                NewPortMappingDescription: serverName,
                NewLeaseDuration: 0
            };

            const soapXML = createSOAPRequest(
                service.serviceType,
                "AddPortMapping",
                mappingArguments
            );

            const mappingResponse = await ensurePortMapping(
                controlURL,
                service.serviceType,
                port,
                localIP,
                addPortMapping,
                deletePortMapping,
                serverName
            );

            return externalIP;

        } catch (error) {
            console.error("\nSOAP request failed:");
            console.error(error);
        }

    } catch (error) {
        console.error(error);
    }
}
