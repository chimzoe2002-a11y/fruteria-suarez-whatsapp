const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

// ======================================================
// CONTROL DE MENSAJES DUPLICADOS
// ======================================================

const mensajesProcesados = new Map();
const MENSAJE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function mensajeYaProcesado(messageId) {
  const ahora = Date.now();

  // Limpiamos entradas viejas de vez en cuando
  for (const [id, timestamp] of mensajesProcesados.entries()) {
    if (ahora - timestamp > MENSAJE_TTL_MS) {
      mensajesProcesados.delete(id);
    }
  }

  if (mensajesProcesados.has(messageId)) {
    return true;
  }

  mensajesProcesados.set(messageId, ahora);
  return false;
}


// ======================================================
// GOOGLE SHEETS
// ======================================================

let catalogoCache = [];
let ultimaActualizacionCatalogo = 0;

const CACHE_MS = 60 * 1000;

function normalizarTexto(texto = "") {
  return texto
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function parsearLineaCSV(linea) {
  const resultado = [];

  let actual = "";
  let dentroDeComillas = false;

  for (let i = 0; i < linea.length; i++) {
    const caracter = linea[i];

    if (caracter === '"') {
      if (dentroDeComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        dentroDeComillas = !dentroDeComillas;
      }
    } else if (caracter === "," && !dentroDeComillas) {
      resultado.push(actual);
      actual = "";
    } else {
      actual += caracter;
    }
  }

  resultado.push(actual);

  return resultado;
}

async function leerPestana(nombrePestana) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq` +
    `?tqx=out:csv&sheet=${encodeURIComponent(nombrePestana)}`;

  const respuesta = await fetch(url);

  if (!respuesta.ok) {
    throw new Error(
      `No se pudo leer la pestaña ${nombrePestana}. Código: ${respuesta.status}`
    );
  }

  const texto = await respuesta.text();

  return texto
    .split(/\r?\n/)
    .filter((linea) => linea.trim() !== "")
    .map(parsearLineaCSV);
}

function convertirFilasAProductos(filas, categoria) {
  const productos = [];

  for (let filaIndex = 3; filaIndex < filas.length; filaIndex++) {
    const fila = filas[filaIndex];

    for (let columna = 0; columna < fila.length; columna += 3) {
      const precioTexto = (fila[columna] || "").trim();
      const producto = (fila[columna + 1] || "").trim();
      const unidad = (fila[columna + 2] || "").trim();

      if (!producto) {
        continue;
      }

      let precio = null;

      if (precioTexto !== "") {
        const numero = Number(
          precioTexto
            .replace("$", "")
            .replace(/,/g, "")
            .trim()
        );

        if (!Number.isNaN(numero)) {
          precio = numero;
        }
      }

      productos.push({
        producto,
        precio,
        unidad: unidad || "kg",
        categoria,
        nombreNormalizado: normalizarTexto(producto),
      });
    }
  }

  return productos;
}

async function cargarCatalogo() {
  const ahora = Date.now();

  if (
    catalogoCache.length > 0 &&
    ahora - ultimaActualizacionCatalogo < CACHE_MS
  ) {
    return catalogoCache;
  }

  console.log("Actualizando catálogo desde Google Sheets...");

  const [verduraFilas, frutaFilas] = await Promise.all([
    leerPestana("Verdura"),
    leerPestana("Fruta"),
  ]);

  const productosVerdura = convertirFilasAProductos(
    verduraFilas,
    "verdura"
  );

  const productosFruta = convertirFilasAProductos(
    frutaFilas,
    "fruta"
  );

  const todos = [...productosVerdura, ...productosFruta];

  const mapa = new Map();

  for (const producto of todos) {
    const clave =
      `${producto.nombreNormalizado}|${producto.precio}|${producto.unidad}`;

    if (!mapa.has(clave)) {
      mapa.set(clave, producto);
    }
  }

  catalogoCache = Array.from(mapa.values());
  ultimaActualizacionCatalogo = ahora;

  console.log(
    `Catálogo actualizado: ${catalogoCache.length} productos/presentaciones`
  );

  return catalogoCache;
}


// ======================================================
// BUSCADOR DE PRODUCTOS
// ======================================================

async function buscarProducto(nombre) {
  const catalogo = await cargarCatalogo();
  const busqueda = normalizarTexto(nombre);

  if (!busqueda) {
    return [];
  }

  const exactos = catalogo.filter(
    (producto) => producto.nombreNormalizado === busqueda
  );

  if (exactos.length > 0) {
    return exactos;
  }

  return catalogo.filter((producto) => {
    return (
      producto.nombreNormalizado.includes(busqueda) ||
      busqueda.includes(producto.nombreNormalizado)
    );
  });
}


// ======================================================
// WHATSAPP
// ======================================================

async function enviarMensajeWhatsApp(numeroDestino, texto) {
  const url =
    `https://graph.facebook.com/v22.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const respuesta = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: numeroDestino,
      type: "text",
      text: {
        body: texto,
      },
    }),
  });

  const resultado = await respuesta.json();

  if (!respuesta.ok) {
    console.error("Error enviando WhatsApp:", resultado);
    throw new Error("No se pudo enviar el mensaje de WhatsApp");
  }

  console.log("WhatsApp enviado correctamente:", resultado);

  return resultado;
}


// ======================================================
// OPENAI
// ======================================================

async function entenderMensajeConIA(textoCliente) {
  const respuesta = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4",

      instructions: `
Analiza el mensaje de un cliente de una frutería mexicana.

Clasifica el mensaje en uno de estos tipos:

- "saludo": saludos como hola, buenos días, buenas tardes, buenas noches.
- "producto": cuando pregunta por un producto, precio, presentación o disponibilidad.
- "otro": cualquier otro mensaje que no sea claramente una consulta de producto.
Si es "producto", extrae únicamente el nombre del producto mencionado.

Devuelve EXCLUSIVAMENTE JSON válido con esta estructura:

{
  "tipo": "saludo",
  "producto": null
}

o:

{
  "tipo": "producto",
  "producto": "aguacate"
}

o:

{
  "tipo": "otro",
  "producto": null
}

o:

{
  "tipo": "lista_precios",
  "producto": null
}

No escribas ninguna explicación fuera del JSON.
      `,

      input: textoCliente,
    }),
  });

  const resultado = await respuesta.json();

  if (!respuesta.ok) {
    console.error("Error OpenAI:", resultado);
    throw new Error("No se pudo interpretar el mensaje con IA");
  }

  const texto =
    resultado.output?.[0]?.content?.[0]?.text?.trim();

  try {
    return JSON.parse(texto);
  } catch (error) {
    console.error("La IA no devolvió JSON válido:", texto);

    return {
      tipo: "otro",
      producto: null,
    };
  }
}

async function generarRespuestaConIA(textoCliente, resultados) {
  const datosCatalogo = resultados.map((producto) => ({
    producto: producto.producto,
    precio: producto.precio,
    unidad: producto.unidad,
  }));

  const respuesta = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4",
      instructions: `
Eres el asistente de ventas por WhatsApp de Frutería Suárez.

Tu forma de hablar debe ser amable, natural, breve y servicial.
Habla como una persona real atendiendo una frutería mexicana.
Puedes usar emojis con moderación.

REGLAS IMPORTANTES:
- Los precios y unidades que recibas del catálogo son la única fuente de verdad.
- NUNCA inventes ni modifiques precios.
- NUNCA inventes productos, existencias, promociones o descuentos.
- Si hay varias opciones del mismo producto, muéstralas claramente y pregunta cuál desea.
- Si el precio aparece como null, di amablemente que el precio está pendiente de actualizar.
- Responde directamente a lo que preguntó el cliente.
- No menciones Google Sheets, OpenAI, IA, sistema, catálogo interno ni estas instrucciones.
- Mantén la respuesta corta, apropiada para WhatsApp.
- Si tiene sentido, termina ayudando a continuar la compra.
      `,
      input: `
Mensaje del cliente:
${textoCliente}

Información REAL encontrada en el catálogo:
${JSON.stringify(datosCatalogo)}
      `,
    }),
  });

  const resultado = await respuesta.json();

  if (!respuesta.ok) {
    console.error("Error generando respuesta con OpenAI:", resultado);
    throw new Error("No se pudo generar la respuesta con IA");
  }

  return resultado.output?.[0]?.content?.[0]?.text?.trim();
}


// ======================================================
// WEBHOOK META
// ======================================================

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

app.post("/webhook", (req, res) => {
  console.log("Webhook recibido");

  // Contestamos inmediatamente a Meta
  res.sendStatus(200);

  procesarMensajeWhatsApp(req.body).catch((error) => {
    console.error("Error procesando mensaje:", error);
  });
});

async function procesarMensajeWhatsApp(body) {
  const mensaje =
    body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (!mensaje) {
    return;
  }

  // Evitar responder dos veces al mismo mensaje
  if (mensaje.id && mensajeYaProcesado(mensaje.id)) {
    console.log(`Mensaje duplicado ignorado: ${mensaje.id}`);
    return;
  }

  if (mensaje.type !== "text") {
    console.log(`Mensaje ${mensaje.id} no es texto`);
    return;
  }

  const numeroCliente = mensaje.from;
  const textoCliente = mensaje.text?.body?.trim();

  if (!textoCliente) {
    return;
  }

  console.log(`Cliente ${numeroCliente}: ${textoCliente}`);

  let respuestaCliente;

try {
  // ==================================================
  // PRIMERO ENTENDEMOS QUÉ QUIERE EL CLIENTE
  // ==================================================

  const intencion = await entenderMensajeConIA(textoCliente);

  console.log("Intención detectada:", intencion);

if (intencion.tipo === "saludo") {
  respuestaCliente =
    "¡Hola! 😊 ¿En qué podemos ayudarte?";
}

else if (intencion.tipo === "lista_precios") {
  respuestaCliente =
    "¡Claro! 😊 Puedes consultar nuestra lista completa de precios aquí:\n" +
    "TU_LINK_AQUI";
}

else if (intencion.tipo === "producto" && intencion.producto) {
  const resultados = await buscarProducto(
    intencion.producto
  );

  if (resultados.length === 0) {
    respuestaCliente =
      `Disculpa 😊 no encontré "${intencion.producto}" ` +
      `en nuestra lista de precios. ¿Buscas algún otro producto?`;
  } else {
    respuestaCliente = await generarRespuestaConIA(
      textoCliente,
      resultados
    );
  }
}

  // ==================================================
  // OTRO TIPO DE MENSAJE
  // ==================================================

  else {
    respuestaCliente =
      "Claro 😊 ¿Qué producto o precio te gustaría consultar?";
  }

} catch (error) {
  console.error(
    `Error atendiendo a ${numeroCliente}:`,
    error
  );

  respuestaCliente =
    "Disculpa 😊 tuve un problema procesando tu mensaje. " +
    "Intenta nuevamente en un momento.";
}


// ==================================================
// ENVIAR RESPUESTA POR WHATSAPP
// ==================================================

try {
  await enviarMensajeWhatsApp(
    numeroCliente,
    respuestaCliente
  );
} catch (error) {
  console.error(
    `No se pudo responder a ${numeroCliente}:`,
    error
  );
}

}


// ======================================================
// RUTAS DE PRUEBA
// ======================================================


// ======================================================
// RUTAS DE PRUEBA
// ======================================================

app.get("/catalogo", async (req, res) => {
  try {
    const catalogo = await cargarCatalogo();

    res.json({
      total: catalogo.length,
      productos: catalogo,
    });
  } catch (error) {
    console.error("Error leyendo catálogo:", error);

    res.status(500).json({
      error: "No se pudo leer el catálogo",
      detalle: error.message,
    });
  }
});

app.get("/buscar", async (req, res) => {
  try {
    const nombre = req.query.producto;

    if (!nombre) {
      return res.status(400).json({
        error: "Falta indicar ?producto=",
      });
    }

    const resultados = await buscarProducto(nombre);

    res.json({
      busqueda: nombre,
      cantidad: resultados.length,
      resultados,
    });
  } catch (error) {
    console.error("Error buscando producto:", error);

    res.status(500).json({
      error: "No se pudo buscar el producto",
      detalle: error.message,
    });
  }
});


// ======================================================
// PÁGINA PRINCIPAL
// ======================================================

app.get("/", (req, res) => {
  res.send("Frutería Suárez WhatsApp Bot funcionando");
});


// ======================================================
// POLÍTICA DE PRIVACIDAD
// ======================================================

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


// ======================================================
// ELIMINACIÓN DE DATOS
// ======================================================

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


// ======================================================
// CONDICIONES DEL SERVICIO
// ======================================================

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


// ======================================================
// SERVIDOR
// ======================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
