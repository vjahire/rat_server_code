const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const uuid4 = require('uuid');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');

const app = express();
const server = http.createServer(app);

// Configure multer to save files in dynamic directories based on device model
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const model = req.headers['model'];
        const uploadPath = path.join(__dirname, 'uploads', model);

        // Create the directory if it doesn't exist
        fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

// Middleware for parsing JSON bodies
app.use(bodyParser.json());

// Serve the index.html file
app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
        if (err) {
            res.status(500).send('Error loading index.html');
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.send(data);
        }
    });
});

// WebSocket servers
const webSocketServer = new WebSocket.Server({ noServer: true });
const deviceSocketServer = new WebSocket.Server({ noServer: true });

const webClients = new Set();
const deviceClients = new Map();

// Handle WebSocket connections from the web interface
webSocketServer.on('connection', (ws) => {
    webClients.add(ws);
    console.log('Web client connected');

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const targetDevice = data.target;
        const command = data.command;

        console.log(`Command from web client: ${command} to device: ${targetDevice}`);

        // Forward command to the specified device only
        const deviceWs = Array.from(deviceClients.values()).find(client => client.model === targetDevice)?.ws;
        if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
            deviceWs.send(command.toString());
        }
    });

    ws.on('close', () => {
        console.log('Web client disconnected');
        webClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error: ${error}`);
    });

    // Send the current list of active devices to the new web client
    notifyWebClient(ws);
});

// Handle WebSocket connections from devices
deviceSocketServer.on('connection', (ws, req) => {
    const uuid = uuid4.v4();
    const model = req.headers['model'];
    const battery = req.headers['battery'];
    const version = req.headers['version'];
    const brightness = req.headers['brightness'];
    const provider = req.headers['provider'];

    ws.uuid = uuid;
    const deviceInfo = {
        model: model,
        battery: battery,
        version: version,
        brightness: brightness,
        provider: provider
    };
    deviceClients.set(uuid, { ws, ...deviceInfo });

    console.log(`Device connected: ${JSON.stringify(deviceInfo)}`);
    notifyWebClients(`Device connected: ${JSON.stringify(deviceInfo)}`);
    updateDeviceList();

    ws.on('message', (message) => {
        console.log(`Message from device: ${message}`);
        // Forward message to all web clients
        webClients.forEach(webWs => {
            if (webWs.readyState === WebSocket.OPEN) {
                webWs.send(message.toString());
            }
        });
    });

    ws.on('close', () => {
        console.log('Device disconnected');
        notifyWebClients(`Device disconnected: ${uuid}`);
        deviceClients.delete(uuid);
        updateDeviceList();
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error: ${error}`);
    });
});

// Notify all web clients about device events
function notifyWebClients(message) {
    webClients.forEach(webWs => {
        if (webWs.readyState === WebSocket.OPEN) {
            webWs.send(message.toString());
        }
    });
}

// Send the current list of active devices to a specific web client
function notifyWebClient(ws) {
    if (ws.readyState === WebSocket.OPEN) {
        const devices = Array.from(deviceClients.values()).map(client => client.model);
        ws.send(JSON.stringify({ type: 'device_list', devices: devices }));
    }
}

// Update all web clients with the current list of active devices
function updateDeviceList() {
    const devices = Array.from(deviceClients.values()).map(client => client.model);
    const message = JSON.stringify({ type: 'device_list', devices: devices });
    webClients.forEach(webWs => {
        if (webWs.readyState === WebSocket.OPEN) {
            webWs.send(message);
        }
    });
}

// Add a new endpoint for uploading text
app.post('/uploadText', (req, res) => {
    const model = req.headers['model'];
    const text = req.body['text'];

    if (!model || !text) {
        return res.status(400).send('Missing model or text');
    }

    const message = `Message from: ${model} device\n\n${text}`;
    console.log(`Received text upload: ${message}`);
    
    webClients.forEach(webWs => {
        if (webWs.readyState === WebSocket.OPEN) {
            webWs.send(message);
        }
    });

    res.send('success');
});

// Add a new endpoint for uploading location
app.post('/uploadLocation', (req, res) => {
    const model = req.headers['model'];
    const lat = req.body['lat'];
    const lon = req.body['lon'];

    if (!model || !lat || !lon) {
        return res.status(400).send('Missing model, latitude or longitude');
    }

    const locationMessage = `Location from: ${model} device\nLatitude: ${lat}\nLongitude: ${lon}`;
    console.log(`Received location upload: ${locationMessage}`);
    
    webClients.forEach(webWs => {
        if (webWs.readyState === WebSocket.OPEN) {
            webWs.send(locationMessage);
        }
    });

    res.send('success');
});

// Add the new endpoint
app.post("/uploadFile", upload.single('file'), (req, res) => {
    const id = req.headers['id']; // Ensure you are getting the correct id from headers or request
    const model = req.headers['model'];
    const name = req.file.originalname;
    const size = req.file.size;

    const message = `Message from ${model} device: File uploaded - ${name} (${size} bytes)`;

    webClients.forEach(webWs => {
        if (webWs.readyState === WebSocket.OPEN) {
            webWs.send(message);
        }
    });

    res.send('success');
});

// Upgrade HTTP server to handle WebSocket connections
server.on('upgrade', (request, socket, head) => {
    const pathname = request.url;

    if (pathname === '/web') {
        webSocketServer.handleUpgrade(request, socket, head, (ws) => {
            webSocketServer.emit('connection', ws, request);
        });
    } else if (pathname === '/device') {
        deviceSocketServer.handleUpgrade(request, socket, head, (ws) => {
            deviceSocketServer.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
