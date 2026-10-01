# Easy-Self-Hosting
Main purpose is to provide templates for easy server hosting on your own device with minimal setup and easy customization. UPNP is used so you don't have to set up port forwarding.

___
## Installation
The main branch is windows only, but is very nice because it comes with an app to make it easier to use and a couple more features. Use by double clicking the app.exe file after extracting the full project.

The v1 branch is the code for the first version of this project and has a windows and linux version. It does not have an app and instead you run the start.sh / start.bat and a terminal will open which is the node process controlling your server.
It does not include removal of port mapping when closing the server!

___
## General use
1. Put your files that you would like to host on the internet in the `\server\public\` (v2) or `\public\` (v1) folder.
2. Run the server by double-clicking app.exe (v2) or running start.bat/start.sh (v1).
<img width="808" height="640" alt="image" src="https://github.com/user-attachments/assets/3e706858-aaf3-4837-a6f8-eab60d146364" />

3. Test the server by having someone go to the external ip link listed in the app log (v2) or terminal (v1).
<img width="280" height="195" alt="image" src="https://github.com/user-attachments/assets/1f341838-02fe-4bb6-b933-b4c867960f42" />

4. To access a specific non index.html file, visit [external ip link]/[file name] (example url: http://129.81.33.105:8080/funnyJokes.html)

___
## Other Info
Make sure to stop the server with the button on the app before closing it.
To change the port, edit the variable `PORT` in `\server\server.js`
If you want to customize your server more, you can install node modules to the project root and edit the server.js to have it do whatever you want.
