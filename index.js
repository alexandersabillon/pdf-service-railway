import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '20mb' }));

let browser = null;
const queue = [];
let activeWorkers = 0;
const MAX_WORKERS = 3; // máximo de PDFs simultáneos

async function getBrowser() {
    try {
        if (browser && browser.connected) return browser;
        
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

        return browser;
    } catch (error) {
        browser = null;
        throw error;
    }
}

async function processQueue() {
    // Si alcanzó el máximo de workers o no hay requests, salir
    if (activeWorkers >= MAX_WORKERS || queue.length === 0) return;

    activeWorkers++;
    const { req, res } = queue.shift();
    console.log(`Procesando PDF. Workers activos: ${activeWorkers}, En cola: ${queue.length}`);

    let page = null;
    try {
        const { html, filename, documentId, showFooter } = req.body;

        const browserInstance = await getBrowser();
        page = await browserInstance.newPage();

        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

        const pdfBuffer = await page.pdf({
            format: 'A4',
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
        browser = null;
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