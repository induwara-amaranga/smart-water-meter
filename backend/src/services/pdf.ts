import PDFDocument from 'pdfkit';

const money = (c: number) => `Rs. ${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: unknown) => (d ? new Date(d as string).toDateString() : '-');

/** Render a published bill as a one-page PDF. */
export function billPdf(bill: any, account: { account_no: string; holder_name: string; address: string; meter_id: string | null }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const [y, m] = String(bill.period).split('-').map(Number);
    const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    doc.fontSize(20).fillColor('#1D4ED8').text('Smart Water', { continued: true }).fillColor('#000').text(`  ·  Water bill`);
    doc.moveDown(0.3).fontSize(12).fillColor('#555').text(month);
    doc.moveDown();

    doc.fillColor('#000').fontSize(11);
    doc.text(`Account: ${account.account_no}`);
    doc.text(`Name: ${account.holder_name}`);
    if (account.address) doc.text(`Address: ${account.address}`);
    doc.text(`Meter: ${account.meter_id ?? '-'}`);
    doc.moveDown();

    doc.text(`Previous reading: ${(bill.openingL / 1000).toFixed(3)} m³`);
    doc.text(`Current reading:  ${(bill.closingL / 1000).toFixed(3)} m³   (${date(bill.readingDate)})`);
    doc.text(`Consumption:      ${bill.usageM3.toFixed(3)} m³`);
    if (bill.dataBasis !== 'LIVE') {
      doc.fillColor('#B45309').text(bill.dataBasis === 'SD_SYNCED' ? 'Includes readings uploaded after the meter was offline.' : 'Estimated: the meter did not report for part of the month.');
      doc.fillColor('#000');
    }
    doc.moveDown();

    const left = 50;
    const right = 545;
    doc.font('Helvetica-Bold').text('Charges');
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).stroke('#ccc');
    doc.moveDown(0.5).font('Helvetica');
    for (const l of bill.lines) {
      const y0 = doc.y;
      const desc = l.qtyM3 != null ? `${l.description}: ${l.qtyM3.toFixed(2)} m³ × ${money(l.rateCents)}` : l.description;
      doc.text(desc, left, y0, { width: 380 });
      doc.text(money(l.amountCents), 400, y0, { width: right - 400, align: 'right' });
      doc.moveDown(0.3);
    }
    doc.moveTo(left, doc.y + 2).lineTo(right, doc.y + 2).stroke('#ccc');
    doc.moveDown(0.5).font('Helvetica-Bold');
    const yt = doc.y;
    doc.text('Total due', left, yt);
    doc.text(money(bill.totalCents), 400, yt, { width: right - 400, align: 'right' });
    doc.font('Helvetica').moveDown();
    doc.text(`Due date: ${date(bill.dueDate)}`, left);
    doc.text(`Status: ${bill.status}`);
    doc.moveDown(2).fontSize(9).fillColor('#777').text('Smart meter readings are accurate to about ±10%. Very slow drips (under 1 L/min) may not be detected.');
    doc.end();
  });
}
