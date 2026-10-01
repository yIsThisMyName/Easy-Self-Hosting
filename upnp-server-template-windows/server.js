import express from "express";
import { setupUPnP } from "./custom-upnp-setup.js";

const PORT = 8080;
const SERVER_NAME = 'y\'s test server';

const app = express();

app.use(express.static("public"));

try {
    const externalIP = await setupUPnP(SERVER_NAME,PORT);

    app.listen(PORT, () => {
        console.log("\nServer is running!");
        console.log(`Local: http://localhost:${PORT}`);
        console.log(`External: http://${externalIP}:${PORT}`);
    });

} catch (error) {
    console.error("Failed to set up UPnP:");
    console.error(error);
}