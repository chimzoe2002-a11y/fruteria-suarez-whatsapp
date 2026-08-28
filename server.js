const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Ruta para verificar el webhook con Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado correctamente");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Ruta para recibir mensajes de WhatsApp
app.post("/webhook", (req, res) => {
  console.log("Mensaje recibido:");
  console.log(JSON.stringify(req.body, null, 2));

  res.sendStatus(200);
});

// Ruta para comprobar que el servidor está funcionando
app.get("/", (req, res) => {
  res.send("Frutería Suárez WhatsApp Bot funcionando");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
