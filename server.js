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

// Página principal
app.get("/", (req, res) => {
  res.send("Frutería Suárez WhatsApp Bot funcionando");
});

// Política de privacidad
app.get("/privacidad", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Política de Privacidad - Frutería Suárez</title>
      </head>
      <body>
        <h1>Política de Privacidad de Frutería Suárez</h1>

        <p>
          Frutería Suárez utiliza WhatsApp para recibir y gestionar
          comunicaciones relacionadas con pedidos y atención a clientes.
        </p>

        <h2>Información que podemos recibir</h2>
        <p>
          Cuando una persona se comunica con nosotros mediante WhatsApp,
          podemos recibir información como su número de teléfono, nombre
          disponible en WhatsApp, contenido de los mensajes y datos
          relacionados con sus pedidos.
        </p>

        <h2>Uso de la información</h2>
        <p>
          La información se utiliza únicamente para gestionar pedidos,
          brindar atención al cliente, dar seguimiento a pagos y mejorar
          la operación del servicio.
        </p>

        <h2>Compartición de información</h2>
        <p>
          Frutería Suárez no vende la información personal de sus clientes.
          Los datos podrán ser procesados mediante proveedores tecnológicos
          necesarios para operar nuestros sistemas y servicios.
        </p>

        <h2>Eliminación de datos</h2>
        <p>
          Los usuarios pueden solicitar la eliminación de sus datos
          siguiendo las instrucciones disponibles en nuestra página de
          eliminación de datos.
        </p>

        <h2>Contacto</h2>
        <p>
          Para preguntas relacionadas con esta política, puedes comunicarte
          con Frutería Suárez mediante nuestros canales habituales de atención.
        </p>

        <p>Última actualización: 28 de agosto de 2026.</p>
      </body>
    </html>
  `);
});

// Instrucciones para eliminación de datos
app.get("/eliminar-datos", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Eliminación de datos - Frutería Suárez</title>
      </head>
      <body>
        <h1>Solicitud de eliminación de datos</h1>

        <p>
          Si deseas solicitar la eliminación de la información personal
          asociada a tus comunicaciones con Frutería Suárez, envíanos una
          solicitud mediante nuestro canal habitual de atención por WhatsApp.
        </p>

        <p>
          Indica que deseas ejercer tu derecho de eliminación de datos.
          Podremos solicitar información razonablemente necesaria para
          identificar los datos correspondientes a tu solicitud.
        </p>

        <p>
          Una vez validada la solicitud, eliminaremos la información que
          corresponda, salvo aquella que debamos conservar por obligaciones
          legales o administrativas aplicables.
        </p>
      </body>
    </html>
  `);
});

// Condiciones del servicio
app.get("/terminos", (req, res) => {
  res.send(`
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Condiciones del servicio - Frutería Suárez</title>
      </head>
      <body>
        <h1>Condiciones del servicio de Frutería Suárez</h1>

        <p>
          Los canales digitales de Frutería Suárez se utilizan para facilitar
          la comunicación con clientes, recibir pedidos, proporcionar
          información y dar seguimiento a operaciones relacionadas con
          nuestros servicios.
        </p>

        <p>
          El uso de nuestros canales de comunicación implica la aceptación
          de estas condiciones y de nuestra Política de Privacidad.
        </p>

        <p>
          Frutería Suárez podrá actualizar estas condiciones cuando sea
          necesario para reflejar cambios en sus servicios u operación.
        </p>

        <p>Última actualización: 28 de agosto de 2026.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
