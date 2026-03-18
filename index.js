import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '20mb' }));

let browser = null;
const queue = [];
let activeWorkers = 0;
const MAX_WORKERS = 3; // máximo de PDFs simultáneos

let browserFailCount = 0;
const MAX_BROWSER_FAILS = 3; // reiniciar proceso después de 3 fallos seguidos


async function getBrowser() {
    try {
        if (browser && browser.connected) {
            browserFailCount = 0; // resetear contador si está bien
            return browser;
        }
        
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }

        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--max-old-space-size=512'
            ]
        });

        browser.on('disconnected', () => {
            console.log('Browser desconectado, reseteando...');
            browser = null;
        });

        browserFailCount = 0; // resetear contador si lanzó bien
        return browser;

    } catch (error) {
        browser = null;
        browserFailCount++;
        console.error(`Browser falló. Intento ${browserFailCount} de ${MAX_BROWSER_FAILS}`);

        // ✅ Si falla muchas veces seguidas, matar el proceso para que Railway lo reinicie
        if (browserFailCount >= MAX_BROWSER_FAILS) {
            console.error('Demasiados fallos, reiniciando servicio...');
            process.exit(1); // Railway detecta esto y reinicia automáticamente
        }

        throw error;
    }
}

// ✅ Reiniciar el browser cada 30 minutos para liberar memoria
const BROWSER_RESTART_INTERVAL = 30 * 60 * 1000; // 30 minutos

setInterval(async () => {
    if (activeWorkers === 0 && browser) {
        console.log('Reinicio programado del browser para liberar memoria...');
        await browser.close().catch(() => {});
        browser = null;
    }
}, BROWSER_RESTART_INTERVAL);

async function processQueue() {
    // Si alcanzó el máximo de workers o no hay requests, salir
    if (activeWorkers >= MAX_WORKERS || queue.length === 0) return;

    activeWorkers++;
    const { req, res } = queue.shift();
    console.log(`Procesando PDF. Workers activos: ${activeWorkers}, En cola: ${queue.length}`);

    let page = null;
    try {
        const { html, filename, documentId, showFooter, format, landscape } = req.body;

        const browserInstance = await getBrowser();
        page = await browserInstance.newPage();

        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

        const pdfBuffer = await page.pdf({
            format: format || 'A4',
            landscape: landscape || false,
            printBackground: true,
            margin: {
                top: '0px',
                bottom: showFooter ? '40px' : '0px',
                left: '0px',
                right: '0px'
            },
            displayHeaderFooter: showFooter || false,
            headerTemplate: '<span></span>',
            footerTemplate: showFooter ? `
                <div style="
                    width: 100%;
                    font-size: 10px;
                    font-family: Arial, sans-serif;
                    padding: 0 20px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-sizing: border-box;
                ">
                    <span style="color: #555;">${documentId || ''}</span>
                    <span style="color: #555;">
                        Página <span class="pageNumber"></span> de <span class="totalPages"></span>
                    </span>
                </div>
            ` : '<span></span>'
        });

        await page.close();
        page = null;

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${filename || 'factura.pdf'}"`
        });
        res.status(200).send(pdfBuffer);

    } catch (error) {
        console.error('Error generating PDF:', error);
        if (page) await page.close().catch(() => {});
        
        // ✅ contar fallo y verificar si debe reiniciar
        browser = null;
        browserFailCount++;
        console.error(`Fallo en processQueue. Contador: ${browserFailCount} de ${MAX_BROWSER_FAILS}`);
        
        if (browserFailCount >= MAX_BROWSER_FAILS) {
            console.error('Demasiados fallos en processQueue, reiniciando servicio...');
            process.exit(1);
        }

        res.status(500).json({ error: 'Failed to generate PDF', detail: error.message });
    } finally {
        activeWorkers--;
        console.log(`PDF completado. Workers activos: ${activeWorkers}, En cola: ${queue.length}`);
        // ✅ procesar siguiente inmediatamente
        processQueue();
    }
}

app.post('/generate-pdf', (req, res) => {
    if (!req.body.html) {
        return res.status(400).json({ error: 'HTML is required' });
    }

    console.log(`Request recibido. Cola: ${queue.length + 1}, Workers: ${activeWorkers}`);
    queue.push({ req, res });
    processQueue();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF service running on port ${PORT}`));