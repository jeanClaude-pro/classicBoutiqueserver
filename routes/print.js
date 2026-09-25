const express = require('express');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const {
  amountRow,
  itemTableRows,
  lineWidth,
  receiptLabels,
  receiptLines,
  receiptTotalFC,
} = require('../utils/receiptLayout');

router.use(authMiddleware);

// Customer-facing money on the thermal receipt and stub is FC only; see
// utils/receiptLayout.js for the historical FC value of each line.
function receiptContent(receiptData) {
  const width = lineWidth();
  const labels = receiptLabels(receiptData.labels);
  const lines = receiptLines(receiptData.items, receiptData.exchangeRate);
  const totalFC = receiptTotalFC(lines);
  const payment = String(receiptData.paymentLabel || receiptData.paymentMethod || "").toUpperCase();
  return { width, labels, lines, totalFC, payment };
}

// Find and use the first available USB printer
//printer
function getPrinter() {
  try {
    const device = new escpos.USB();
    return new escpos.Printer(device);
  } catch (error) {
    console.error('No USB printer found:', error);
    return null;
  }
}

// Print receipt endpoint
router.post('/receipt', async (req, res) => {
  try {
    const { receiptData, type = 'sale' } = req.body;
    
    const printer = getPrinter();
    if (!printer) {
      return res.status(500).json({ error: 'No printer found' });
    }

    const device = printer.device;

    device.open(async (error) => {
      if (error) {
        console.error('Printer error:', error);
        return res.status(500).json({ error: 'Printer connection failed' });
      }

      try {
        const { width, labels, lines, totalFC, payment } = receiptContent(receiptData);

        // Print receipt header
        printer
          .font('a')
          .align('ct')
          .style('b')
          .size(2, 2)
          .text(receiptData.shopName || 'ETS DOUBLE M CLASSIC BOUTIQUE')
          .size(1, 1)
          .text(labels.tagline)
          .align('lt')
          .text(receiptData.shopAddress)
          .text(receiptData.shopRegistration)
          .text(receiptData.shopNumber)
          .text(`${labels.date}: ${receiptData.date}`)
          .text(`${labels.receiptNo}: ${receiptData.receiptNumber}`)
          .feed(1);

        // Customer information
        printer
          .style('normal')
          .text(`${labels.customer}: ${receiptData.customerName}`);

        if (receiptData.customerPhone) {
          printer.text(`${labels.phone}: ${receiptData.customerPhone}`);
        }

        if (receiptData.customerEmail) {
          printer.text(`${labels.email}: ${receiptData.customerEmail}`);
        }

        printer.feed(1);

        // Items: ARTICLE | PU | QTE | TOTAL, FC only
        for (const row of itemTableRows(lines, labels, width)) printer.text(row);

        // Totals
        printer
          .style('b')
          .text(amountRow(labels.subtotal, totalFC, width))
          .text(amountRow(labels.total, totalFC, width))
          .text(`${labels.payment}: ${payment}`)
          .feed(1);

        // Sales person
        printer
          .style('normal')
          .text(`${labels.agent}: ${receiptData.salesPerson}`)
          .feed(1);

        // Footer
        printer
          .align('ct')
          .text(receiptData.receiptFooter || labels.thanks)
          .text(labels.noExchange)
          .feed(2);

        if (type === 'reservation') {
          printer
            .style('b')
            .text('✅ RESERVATION CONFIRMÉE')
            .feed(1);
        }

        // Cut the paper (full cut)
        printer.cut();
        
        await new Promise((resolve) => {
          printer.close(() => {
            resolve();
          });
        });

        res.json({ success: true, message: 'Receipt printed successfully' });
      } catch (printError) {
        console.error('Print error:', printError);
        res.status(500).json({ error: 'Print failed' });
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  }
});

// Print stub endpoint
router.post('/stub', async (req, res) => {
  try {
    const { receiptData, type = 'sale' } = req.body;
    
    const printer = getPrinter();
    if (!printer) {
      return res.status(500).json({ error: 'No printer found' });
    }

    const device = printer.device;

    device.open(async (error) => {
      if (error) {
        return res.status(500).json({ error: 'Printer connection failed' });
      }

      try {
        const { width, labels, lines, totalFC, payment } = receiptContent(receiptData);

        // Print stub header
        printer
          .font('a')
          .align('ct')
          .style('b')
          .size(1, 1)
          .text(labels.stubTitle)
          .text(receiptData.shopName || 'ETS DOUBLE M CLASSIC BOUTIQUE')
          .text(labels.tagline)
          .align('lt')
          .text(`${labels.date}: ${receiptData.date}`)
          .text(`${labels.receiptNo}: ${receiptData.receiptNumber}`)
          .feed(1);

        // Customer information
        printer.style('normal').text(`${labels.customer}: ${receiptData.customerName}`);
        if (receiptData.customerPhone) {
          printer.text(`${labels.phone}: ${receiptData.customerPhone}`);
        }
        printer.feed(1);

        // Items: ARTICLE | PU | QTE | TOTAL, FC only
        for (const row of itemTableRows(lines, labels, width)) printer.text(row);

        // Total
        printer
          .style('b')
          .text(amountRow(labels.saleTotal, totalFC, width))
          .text(`${labels.payment}: ${payment}`)
          .feed(1);

        // Sales person
        printer.text(`${labels.agent}: ${receiptData.salesPerson}`);

        // Stub footer
        printer
          .feed(1)
          .align('ct')
          .style('b')
          .text(labels.stubNumber.replace('{{number}}', String(receiptData.stubNumber)))
          .feed(1);

        if (type === 'reservation') {
          printer.text('✅ RESERVATION CONFIRMÉE');
        }

        printer.feed(2);

        // Cut the paper (full cut)
        printer.cut();
        
        await new Promise((resolve) => {
          printer.close(() => {
            resolve();
          });
        });

        res.json({ success: true, message: 'Stub printed successfully' });
      } catch (printError) {
        console.error('Print error:', printError);
        res.status(500).json({ error: 'Print failed' });
      }
    });
  } catch (error) {
    console.error('Server error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Server error' });
  }
});

module.exports = router;
