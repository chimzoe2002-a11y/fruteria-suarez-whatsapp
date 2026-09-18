const express = require("express");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHEET_ID = process.env.SHEET_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
// ======================================================
// SUPABASE
// ======================================================

function headersSupabase(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function buscarConversacionWhatsApp(telefono) {
  const url =
    `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp` +
    `?telefono=eq.${encodeURIComponent(telefono)}` +
    `&select=id,telefono,id_cliente,control_actual,motivo_handoff` +
    `&limit=1`;

  const respuesta = await fetch(url, {
    headers: headersSupabase(),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error buscando conversación: ${detalle}`);
  }

  const datos = await respuesta.json();

  return datos[0] || null;
}

async function crearConversacionWhatsApp(telefono) {
  const respuesta = await fetch(
    `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp`,
    {
      method: "POST",
      headers: headersSupabase({
        Prefer: "return=representation",
      }),
      body: JSON.stringify({
        telefono,
        control_actual: "bot",
        ultimo_mensaje_at: new Date().toISOString(),
      }),
    }
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text();

    // Puede ocurrir si dos mensajes crean la conversación al mismo tiempo.
    // En ese caso intentamos encontrarla nuevamente.
    if (respuesta.status === 409) {
      const existente = await buscarConversacionWhatsApp(telefono);

      if (existente) {
        return existente;
      }
    }

    throw new Error(`Error creando conversación: ${detalle}`);
  }

  const datos = await respuesta.json();

  return datos[0];
}

async function obtenerOCrearConversacionWhatsApp(telefono) {
  let conversacion = await buscarConversacionWhatsApp(telefono);

  if (!conversacion) {
    conversacion = await crearConversacionWhatsApp(telefono);
  }

  return conversacion;
}

async function actualizarActividadConversacion(
  conversacionId,
  fecha = new Date().toISOString()
) {
  const respuesta = await fetch(
    `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp?id=eq.${conversacionId}`,
    {
      method: "PATCH",
      headers: headersSupabase(),
      body: JSON.stringify({
        updated_at: fecha,
        ultimo_mensaje_at: fecha,
      }),
    }
  );

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error actualizando conversación: ${detalle}`);
  }
}

async function guardarMensajeWhatsApp({
  conversacionId,
  telefono,
  messageId = null,
  emisor,
  contenido,
  origen = "whatsapp",
}) {
  const url = messageId
    ? `${SUPABASE_URL}/rest/v1/mensajes_whatsapp?on_conflict=message_id`
    : `${SUPABASE_URL}/rest/v1/mensajes_whatsapp`;

  const prefer = messageId
    ? "resolution=ignore-duplicates,return=minimal"
    : "return=minimal";

  const respuesta = await fetch(url, {
    method: "POST",
    headers: headersSupabase({
      Prefer: prefer,
    }),
    body: JSON.stringify({
      conversacion_id: conversacionId,
      telefono,
      message_id: messageId,
      emisor,
      contenido,
      tipo_mensaje: "texto",
      origen,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error guardando mensaje: ${detalle}`);
  }
}
    async function obtenerHistorialReciente(conversacionId, limite = 20) {
  const url =
    `${SUPABASE_URL}/rest/v1/mensajes_whatsapp` +
    `?conversacion_id=eq.${conversacionId}` +
    `&select=emisor,contenido,created_at` +
    `&order=created_at.desc` +
    `&limit=${limite}`;

  const respuesta = await fetch(url, {
    headers: headersSupabase(),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error obteniendo historial: ${detalle}`);
  }

  const mensajes = await respuesta.json();

  // Supabase los entrega del más nuevo al más viejo.
  // Los regresamos en orden cronológico.
  return mensajes.reverse();
}

function convertirHistorialATexto(historial = []) {
  return historial
    .map((mensaje) => {
      let nombre = "Cliente";

      if (mensaje.emisor === "bot") {
        nombre = "Asistente";
      } else if (mensaje.emisor === "humano") {
        nombre = "Empleado";
      }

      return `${nombre}: ${mensaje.contenido}`;
    })
    .join("\n");
}
async function obtenerMensajesPendientes(conversacionId) {
  const url =
    `${SUPABASE_URL}/rest/v1/mensajes_whatsapp` +
    `?conversacion_id=eq.${conversacionId}` +
    `&emisor=eq.cliente` +
    `&atendido=eq.false` +
    `&select=id,contenido,created_at` +
    `&order=created_at.asc`;

  const respuesta = await fetch(url, {
    headers: headersSupabase(),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error obteniendo pendientes: ${detalle}`);
  }

  return await respuesta.json();
}


async function marcarMensajesPendientesComoAtendidos(conversacionId) {
  const url =
    `${SUPABASE_URL}/rest/v1/mensajes_whatsapp` +
    `?conversacion_id=eq.${conversacionId}` +
    `&emisor=eq.cliente` +
    `&atendido=eq.false`;

  const respuesta = await fetch(url, {
    method: "PATCH",
    headers: headersSupabase(),
    body: JSON.stringify({
      atendido: true,
    }),
  });

  if (!respuesta.ok) {
    const detalle = await respuesta.text();
    throw new Error(`Error marcando pendientes: ${detalle}`);
  }
}
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

- "saludo": cuando el mensaje es principalmente un saludo y no contiene además una consulta.
- "producto": cuando pregunta por uno o varios productos, precios, presentaciones o disponibilidad.
- "lista_precios": cuando pide la lista completa de precios.
- "otro": cualquier otro mensaje.

REGLAS IMPORTANTES:

- Si el cliente saluda y además pregunta por productos, clasifica como "producto".
- Si menciona varios productos, extrae TODOS.
- Devuelve los nombres de los productos sin cantidades ni unidades.
- No ignores productos aunque aparezcan dentro de una oración larga.
- "Hola, cuánto está la fresa" es producto, no saludo.
- "Precio de fresa, uva y durazno" debe devolver los tres productos.

Devuelve EXCLUSIVAMENTE JSON válido.

Ejemplo de saludo:

{
  "tipo": "saludo",
  "productos": []
}

Ejemplo de un producto:

{
  "tipo": "producto",
  "productos": ["aguacate"]
}

Ejemplo de varios productos:

{
  "tipo": "producto",
  "productos": ["fresa", "uva", "durazno"]
}

Ejemplo de lista completa:

{
  "tipo": "lista_precios",
  "productos": []
}

Ejemplo de otro:

{
  "tipo": "otro",
  "productos": []
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
    const intencion = JSON.parse(texto);

    // Protección por si OpenAI devuelve algo inesperado
    if (!Array.isArray(intencion.productos)) {
      intencion.productos = [];
    }

    return intencion;

  } catch (error) {
    console.error("La IA no devolvió JSON válido:", texto);

    return {
      tipo: "otro",
      productos: [],
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
- Los precios, productos y unidades que recibas del catálogo son la única fuente de verdad.

- NUNCA inventes ni modifiques precios.

- NUNCA inventes productos, promociones o descuentos.

- Si un producto aparece en el catálogo, puedes asumir que normalmente lo manejamos.

- Si el cliente pregunta si tenemos un producto que aparece en el catálogo, puedes responder algo natural como:

  "Seguramente sí 😊, aunque la disponibilidad está sujeta al stock del momento."

- NO tienes acceso a cantidades disponibles en inventario.

- NUNCA digas cuántas piezas, kilos, cajas o unidades quedan disponibles.

- NUNCA inventes niveles de stock como "quedan pocas", "hay bastante", "tenemos 20", etc.

- Si el cliente pregunta específicamente cuántas unidades hay disponibles, responde de forma breve que no tienes esa información en tiempo real.

- Si pregunta por disponibilidad exacta o existencias actuales, aclara que debe confirmarse al momento.

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

  // Evitar procesar dos veces el mismo webhook durante esta ejecución
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

  // ==================================================
  // SUPABASE: CONVERSACIÓN + MENSAJE DEL CLIENTE
  // ==================================================

  let conversacion;

  try {
    conversacion =
      await obtenerOCrearConversacionWhatsApp(numeroCliente);

await guardarMensajeWhatsApp({
  conversacionId: conversacion.id,
  telefono: numeroCliente,
  messageId: messageIdBot,
  emisor: "bot",
  contenido: respuestaCliente,
  origen: "whatsapp",
});

await marcarMensajesPendientesComoAtendidos(
  conversacion.id
);

await actualizarActividadConversacion(
  conversacion.id
);

  } catch (error) {
    console.error(
      `Error guardando conversación de ${numeroCliente}:`,
      error
    );
  }


  // ==================================================
  // ¿QUIÉN TIENE EL CONTROL?
  // ==================================================

  if (conversacion?.control_actual === "humano") {
    console.log(
      `Conversación ${conversacion.id} está en modo humano. ` +
      `El bot no responderá a ${numeroCliente}.`
    );

    return;
  }


  // ==================================================
  // RECUPERAR CONTEXTO DE LA CONVERSACIÓN
  // ==================================================

  let historialTexto = "";

  if (conversacion) {
    try {
      const historial =
        await obtenerHistorialReciente(
          conversacion.id,
          20
        );

      historialTexto =
        convertirHistorialATexto(historial);

      console.log(
        `Historial recuperado para ${numeroCliente}:\n` +
        historialTexto
      );

    } catch (error) {
      console.error(
        `No se pudo recuperar historial de ${numeroCliente}:`,
        error
      );
    }
  }


  // ==================================================
  // TEXTO QUE RECIBIRÁ LA IA
  // ==================================================

  const textoConContexto = `
HISTORIAL RECIENTE DE LA CONVERSACIÓN:

${historialTexto || "No hay historial previo disponible."}

MENSAJE ACTUAL DEL CLIENTE:

${textoCliente}

INSTRUCCIONES:
- Interpreta principalmente el MENSAJE ACTUAL.
- Usa el historial solamente para entender referencias o contexto.
- Si el cliente dice cosas como "ese", "lo mismo", "¿y cuánto?", "¿entonces?",
  "dame 3 kilos", etc., usa el historial para saber a qué producto se refiere.
- Los mensajes marcados como "Empleado" fueron escritos por una persona
  que tomó temporalmente la conversación.
`;


  // ==================================================
  // RESPUESTA DEL BOT
  // ==================================================

  let respuestaCliente;

  try {
    const intencion =
      await entenderMensajeConIA(textoConContexto);

    console.log("Intención detectada:", intencion);


    if (intencion.tipo === "saludo") {

      respuestaCliente =
        "¡Hola! 😊 ¿En qué podemos ayudarte?";

    }

    else if (intencion.tipo === "lista_precios") {

      respuestaCliente =
        "¡Claro! 😊 Puedes consultar nuestra lista completa de precios aquí:\n" +
        "https://docs.google.com/spreadsheets/d/1QNznJKlgX5csiHNAVGeZtHal6yso-1n9YnK6oBK2ROQ/edit?usp=sharing";

    }

   else if (
  intencion.tipo === "producto" &&
  Array.isArray(intencion.productos) &&
  intencion.productos.length > 0
) {

  const resultados = [];
  const noEncontrados = [];

  for (const nombreProducto of intencion.productos) {

    const encontrados =
      await buscarProducto(nombreProducto);

    if (encontrados.length === 0) {
      noEncontrados.push(nombreProducto);
    } else {
      resultados.push(...encontrados);
    }

  }

  if (resultados.length === 0) {

    respuestaCliente =
      `Disculpa 😊 no encontré esos productos ` +
      `en nuestra lista de precios. ¿Buscas algún otro producto?`;

  } else {

    respuestaCliente =
      await generarRespuestaConIA(
        textoCliente,
        resultados
      );

    if (noEncontrados.length > 0) {
      respuestaCliente +=
        `\n\nNo encontré en la lista: ${noEncontrados.join(", ")}.`;
    }

  }

}
    

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

    const resultadoEnvio =
      await enviarMensajeWhatsApp(
        numeroCliente,
        respuestaCliente
      );

    const messageIdBot =
      resultadoEnvio?.messages?.[0]?.id || null;


    // ==================================================
    // GUARDAR RESPUESTA DEL BOT EN SUPABASE
    // ==================================================

    if (conversacion) {

      try {

        await guardarMensajeWhatsApp({
          conversacionId: conversacion.id,
          telefono: numeroCliente,
          messageId: messageIdBot,
          emisor: "bot",
          contenido: respuestaCliente,
          origen: "whatsapp",
        });

        await actualizarActividadConversacion(
          conversacion.id
        );

      } catch (error) {

        console.error(
          `No se pudo guardar respuesta del bot en Supabase:`,
          error
        );

      }

    }

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
async function responderPendientesAlRetomar(conversacion) {
  const pendientes =
    await obtenerMensajesPendientes(conversacion.id);

  if (pendientes.length === 0) {
    console.log(
      `Conversación ${conversacion.id}: no hay mensajes pendientes`
    );

    return {
      respondio: false,
      motivo: "sin_pendientes",
    };
  }

  const historial =
    await obtenerHistorialReciente(
      conversacion.id,
      20
    );

  const historialTexto =
    convertirHistorialATexto(historial);

  const mensajesPendientesTexto =
    pendientes
      .map((m) => m.contenido)
      .join("\n");

const textoConContexto = `
HISTORIAL RECIENTE:

${historialTexto}

MENSAJES DEL CLIENTE QUE QUEDARON SIN RESPUESTA:

${mensajesPendientesTexto}

INSTRUCCIONES:
- Retoma la conversación como asistente de Frutería Suárez.
- Los mensajes anteriores quedaron sin respuesta durante una intervención humana.
- Responde ahora lo que quedó pendiente.
- Usa el historial para comprender referencias.
- No menciones que hubo un error técnico ni que estás leyendo una base de datos.
`;
  const intencion =
    await entenderMensajeConIA(textoConContexto);

  let respuestaCliente;

  if (intencion.tipo === "saludo") {

    respuestaCliente =
      "¡Hola! 😊 ¿En qué podemos ayudarte?";

  } else if (intencion.tipo === "lista_precios") {

    respuestaCliente =
      "¡Claro! 😊 Puedes consultar nuestra lista completa de precios aquí:\n" +
      "https://docs.google.com/spreadsheets/d/1QNznJKlgX5csiHNAVGeZtHal6yso-1n9YnK6oBK2ROQ/edit?usp=sharing";

  } else if (
  intencion.tipo === "producto" &&
  Array.isArray(intencion.productos) &&
  intencion.productos.length > 0
) {

  const resultados = [];
  const noEncontrados = [];

  for (const nombreProducto of intencion.productos) {

    const encontrados =
      await buscarProducto(nombreProducto);

    if (encontrados.length === 0) {
      noEncontrados.push(nombreProducto);
    } else {
      resultados.push(...encontrados);
    }

  }

  if (resultados.length === 0) {

    respuestaCliente =
      "Disculpa 😊 no encontré esos productos en nuestra lista de precios.";

  } else {

    respuestaCliente =
      await generarRespuestaConIA(
        mensajesPendientesTexto,
        resultados
      );

    if (noEncontrados.length > 0) {
      respuestaCliente +=
        `\n\nNo encontré en la lista: ${noEncontrados.join(", ")}.`;
    }

  }

}
  
  else {

    respuestaCliente =
      "Claro 😊, retomando tu mensaje anterior, ¿me puedes dar un poco más de detalle para ayudarte?";

  }

  const resultadoEnvio =
    await enviarMensajeWhatsApp(
      conversacion.telefono,
      respuestaCliente
    );

  const messageIdBot =
    resultadoEnvio?.messages?.[0]?.id || null;

  await guardarMensajeWhatsApp({
    conversacionId: conversacion.id,
    telefono: conversacion.telefono,
    messageId: messageIdBot,
    emisor: "bot",
    contenido: respuestaCliente,
    origen: "retomar_handoff",
  });

  await marcarMensajesPendientesComoAtendidos(
    conversacion.id
  );

  await actualizarActividadConversacion(
    conversacion.id
  );

  return {
    respondio: true,
    cantidadPendientes: pendientes.length,
  };
}
app.post("/devolver-al-bot", async (req, res) => {
  try {
    const telefono = req.body?.telefono;

    if (!telefono) {
      return res.status(400).json({
        ok: false,
        error: "Falta telefono",
      });
    }

    const conversacion =
      await buscarConversacionWhatsApp(telefono);

    if (!conversacion) {
      return res.status(404).json({
        ok: false,
        error: "Conversación no encontrada",
      });
    }

    // 1. Devolver control al bot
    const respuestaCambio = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp?id=eq.${conversacion.id}`,
      {
        method: "PATCH",
        headers: headersSupabase(),
        body: JSON.stringify({
          control_actual: "bot",
          motivo_handoff: null,
          tomado_por: null,
          tomado_at: null,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!respuestaCambio.ok) {
      const detalle = await respuestaCambio.text();

      throw new Error(
        `No se pudo devolver control al bot: ${detalle}`
      );
    }

    // 2. Actualizar objeto local
    conversacion.control_actual = "bot";

    // 3. Revisar si quedó algo sin contestar
    const resultadoPendientes =
      await responderPendientesAlRetomar(conversacion);

    return res.json({
      ok: true,
      telefono,
      control_actual: "bot",
      pendientes: resultadoPendientes,
    });

  } catch (error) {
    console.error(
      "Error devolviendo conversación al bot:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: error.message,
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
app.get("/supabase-test", async (req, res) => {
  try {
    const respuesta = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp?select=id,telefono,control_actual&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        },
      }
    );

    if (!respuesta.ok) {
      const error = await respuesta.text();

      console.error("Error Supabase:", error);

      return res.status(500).json({
        ok: false,
        error: error,
      });
    }

    const datos = await respuesta.json();

    res.json({
      ok: true,
      mensaje: "Render conectado correctamente con Supabase",
      registros_encontrados: datos.length,
    });
  } catch (error) {
    console.error("Error conectando con Supabase:", error);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.get("/devolver-al-bot-test", async (req, res) => {
  try {
    const telefono = req.query.telefono;

    if (!telefono) {
      return res.status(400).json({
        ok: false,
        error: "Falta ?telefono=",
      });
    }

    const conversacion =
      await buscarConversacionWhatsApp(telefono);

    if (!conversacion) {
      return res.status(404).json({
        ok: false,
        error: "Conversación no encontrada",
      });
    }

    // Devolver el control al bot
    const respuestaCambio = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones_whatsapp?id=eq.${conversacion.id}`,
      {
        method: "PATCH",
        headers: headersSupabase(),
        body: JSON.stringify({
          control_actual: "bot",
          motivo_handoff: null,
          tomado_por: null,
          tomado_at: null,
          updated_at: new Date().toISOString(),
        }),
      }
    );

    if (!respuestaCambio.ok) {
      const detalle = await respuestaCambio.text();
      throw new Error(
        `No se pudo devolver control al bot: ${detalle}`
      );
    }

    conversacion.control_actual = "bot";

    // Revisar y contestar lo pendiente
    const resultado =
      await responderPendientesAlRetomar(conversacion);

    return res.json({
      ok: true,
      telefono,
      control_actual: "bot",
      resultado,
    });

  } catch (error) {
    console.error("Error retomando conversación:", error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});
app.listen(PORT, () => {
  console.log(`Servidor funcionando en puerto ${PORT}`);
});
