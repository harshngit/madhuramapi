const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2
  }).format(amount || 0);
};

const formatDate = (date) => {
  if (!date) return '-';
  return new Date(date).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
};

const generateEmailTemplate = ({ title, message, infoItems, items, tableHeaders, totalSection, accentColor = '#4c8ac7' }) => {
  const tableHeaderHtml = tableHeaders.map(h => `<th>${h}</th>`).join('');
  
  const tableRowsHtml = items.map(item => {
    const cells = tableHeaders.map(header => {
      const h = header.toLowerCase();
      let value = '-';
      
      // Try to find the value in the item object using common keys
      if (h === 'sr no' || h === 'srno') value = item.srno || item.sr_no || '-';
      else if (h.includes('description')) value = item.description || item.material_description || '-';
      else if (h.includes('qty')) value = item.qty || item.req_qty || item.quantity || '-';
      else if (h.includes('uom') || h === 'unit') value = item.uom || item.UOM || item.unit || '-';
      else if (h.includes('rate')) value = formatCurrency(item.rate || item.Rate || 0);
      else if (h.includes('amount')) value = formatCurrency(item.amount || item.Amount || 0);
      else if (h.includes('make')) value = item.make || '-';
      else if (h.includes('place')) value = item.place_of_utilisation || item.location || '-';
      else if (h.includes('remark')) value = item.remark || '-';
      else {
        // Fallback to exact key match or lowercase match
        const key = header.replace(/ /g, '_');
        value = item[header] || item[key] || item[header.toLowerCase()] || '-';
      }
      
      return `<td>${value}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const infoItemsHtml = infoItems.map(item => `
    <div class="info-item">
      <span class="info-label">${item.label}</span>
      <span class="info-value">${item.value || '-'}</span>
    </div>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; background-color: #f4f7fa; }
    .container { max-width: 800px; margin: 20px auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; background-color: #ffffff; box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
    .header { background-color: ${accentColor}; color: white; padding: 30px; text-align: center; }
    .header .company-name { margin: 0 0 6px 0; font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 2px; opacity: 0.9; }
    .header h1 { margin: 0; font-size: 24px; text-transform: uppercase; letter-spacing: 1px; }
    .content { padding: 30px; }
    .info-section { display: flex; flex-wrap: wrap; margin-bottom: 25px; border-bottom: 2px solid #f0f0f0; padding-bottom: 20px; }
    .info-item { flex: 1; min-width: 200px; margin-bottom: 15px; box-sizing: border-box; padding-right: 10px; }
    .info-label { font-weight: bold; color: ${accentColor}; font-size: 11px; text-transform: uppercase; margin-bottom: 4px; display: block; }
    .info-value { font-size: 14px; color: #333; font-weight: 500; }
    .message-box { background: #f8fbff; border-left: 4px solid ${accentColor}; padding: 15px; margin-bottom: 25px; color: #555; font-size: 15px; }
    .table-container { overflow-x: auto; margin-top: 20px; }
    table { width: 100%; border-collapse: collapse; }
    th { background-color: #f8fbff; color: ${accentColor}; text-align: left; padding: 12px; border-bottom: 2px solid #eef2f7; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; color: #444; }
    .total-section { margin-top: 20px; padding: 20px; background-color: #f8fbff; border-radius: 6px; }
    .total-row { display: flex; justify-content: flex-end; margin-bottom: 8px; font-size: 14px; }
    .total-label { color: #666; margin-right: 20px; min-width: 150px; text-align: right; }
    .total-value { font-weight: bold; color: #333; min-width: 120px; text-align: right; }
    .grand-total { font-size: 18px; color: ${accentColor}; border-top: 1px solid #ddd; padding-top: 10px; margin-top: 10px; }
    .footer { background-color: #f8fbff; padding: 20px; text-align: center; font-size: 12px; color: #777; border-top: 1px solid #eef2f7; }
    @media only screen and (max-width: 600px) {
      .info-item { min-width: 100%; padding-right: 0; }
      .content { padding: 20px; }
      .total-label { min-width: 100px; }
      .total-value { min-width: 80px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="company-name">Madhuram Enterprises</div>
      <h1>${title}</h1>
    </div>
    <div class="content">
      ${message ? `<div class="message-box">${message}</div>` : ''}
      <div class="info-section">
        ${infoItemsHtml}
      </div>
      <div class="table-container">
        <table>
          <thead>
            <tr>${tableHeaderHtml}</tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>
      </div>
      ${totalSection ? `<div class="total-section">${totalSection}</div>` : ''}
    </div>
    <div class="footer">
      <p>This is an automated email from <strong>Madhuram Enterprises</strong>.</p>
      <p>Please do not reply to this email.</p>
    </div>
  </div>
</body>
</html>
  `;
};

module.exports = {
  generateEmailTemplate,
  formatCurrency,
  formatDate
};
