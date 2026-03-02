import express from 'express';
import puppeteer from 'puppeteer';

const app = express();
app.use(express.json({ limit: '20mb' }));

app.post('/generate-pdf', async (req, res) => {
  try {
    const { html, filename } = req.body;

    if (!html) {
      return res.status(400).json({ error: 'HTML is required' });
    }

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    await page.setContent(html, {
      waitUntil: 'networkidle0'
    });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '10px',
        bottom: '10px',
        left: '10px',
        right: '10px'
      }
    });

    await browser.close();

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename || 'factura.pdf'}"`
    });

    return res.status(200).send(pdfBuffer);

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      error: 'Failed to generate PDF',
      detail: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PDF service running on port ${PORT}`);
});