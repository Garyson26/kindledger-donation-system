import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * SPEC-5 5.4. `organisationName` is a PARAMETER, not a constant.
 *
 * This file is one of the two places a component-level find-and-replace would
 * miss - it renders a PDF rather than a page, so it has no access to React
 * context and no `useBranding()` to call. The caller passes the name it already
 * holds.
 *
 * The default keeps every existing call site working and rendering exactly as
 * before, so this change is additive rather than a coordinated edit.
 */
export const generateDonationReceipt = (donation, organisationName = 'Donation Receipt') => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;

  // DEBUG: Log the incoming donation object
  console.log('=== PDF GENERATOR DEBUG ===');
  console.log('Full donation object:', donation);
  console.log('donation.baseAmount:', donation.baseAmount, typeof donation.baseAmount);
  console.log('donation.extraAmount:', donation.extraAmount, typeof donation.extraAmount);
  console.log('donation.amount:', donation.amount, typeof donation.amount);

  // Parse amounts safely to ensure correct values
  const baseAmount = donation.baseAmount ? parseFloat(donation.baseAmount) : 0;
  const extraAmount = donation.extraAmount ? parseFloat(donation.extraAmount) : 0;
  // ALWAYS calculate total from base + extra (don't trust donation.amount field)
  const totalAmount = baseAmount + extraAmount;

  // DEBUG: Log parsed values
  console.log('Parsed baseAmount:', baseAmount);
  console.log('Parsed extraAmount:', extraAmount);
  console.log('Calculated totalAmount:', totalAmount);
  console.log('donation.amount (NOT USED):', donation.amount);
  console.log('Base + Extra =', baseAmount + extraAmount);
  console.log('=========================');

  // Header with logo and organization name
  doc.setFillColor(5, 105, 158);
  doc.rect(0, 0, pageWidth, 45, 'F');

  // Add logo image
  try {
    const logoImg = new Image();
    logoImg.src = '/images/logo.jpg';
    // Add logo - circular frame
    doc.addImage(logoImg, 'JPEG', 12, 10, 20, 20);
  } catch (e) {
    console.log('Logo not loaded:', e);
    // Fallback to placeholder if logo fails to load
    doc.setFillColor(255, 255, 255);
    doc.circle(20, 22, 8, 'F');
    doc.setFillColor(5, 105, 158);
    doc.circle(20, 22, 6, 'F');
  }

  // Organization Name
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(organisationName, pageWidth / 2, 18, { align: 'center' });

  // Receipt Title
  doc.setFontSize(14);
  doc.setFont(undefined, 'normal');
  doc.text('DONATION RECEIPT', pageWidth / 2, 32, { align: 'center' });

  let yPos = 55;

  // Receipt Info
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.setFont(undefined, 'normal');
  const receiptNo = donation.transactionId || `REC-${Date.now()}`;
  const receiptDate = new Date().toLocaleDateString('en-IN');
  doc.text(`Receipt No: ${receiptNo}`, 15, yPos);
  doc.text(`Date: ${receiptDate}`, pageWidth - 15, yPos, { align: 'right' });

  yPos += 15;

  // Donor Information
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(5, 105, 158);
  doc.text('Donor Information', 15, yPos);
  yPos += 8;

  const donorData = [
    ['Donor Name:', donation.userId?.name || donation.donorName || 'Guest User'],
    ['Email:', donation.userId?.email || donation.donorEmail || 'N/A'],
    ['Phone:', donation.donorPhone || 'N/A'],
    ['Type:', donation.userId ? 'Registered User' : 'Guest User']
  ];

  autoTable(doc, {
    startY: yPos,
    body: donorData,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 40, fontStyle: 'bold', textColor: [80, 80, 80] },
      1: { cellWidth: 'auto', textColor: [0, 0, 0] }
    },
    margin: { left: 15 }
  });

  yPos = doc.lastAutoTable.finalY + 12;

  // Donation Details
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(5, 105, 158);
  doc.text('Donation Details', 15, yPos);
  yPos += 8;

  const donationData = [
    ['Category:', donation.category?.name || 'General Donation'],
    ['Purpose:', donation.item || donation.category?.name || 'Donation'],
    ['Quantity:', (donation.quantity || 1).toString()],
    ['Date:', new Date(donation.date).toLocaleDateString('en-IN')]
  ];

  autoTable(doc, {
    startY: yPos,
    body: donationData,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 40, fontStyle: 'bold', textColor: [80, 80, 80] },
      1: { cellWidth: 'auto', textColor: [0, 0, 0] }
    },
    margin: { left: 15 }
  });

  yPos = doc.lastAutoTable.finalY + 12;

  // Amount Breakdown - Table Format
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(5, 105, 158);
  doc.text('Amount Breakdown', 15, yPos);
  yPos += 8;

  const amountBreakdown = [];

  if (baseAmount > 0) {
    amountBreakdown.push([
      'Base Amount',
      `${baseAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    ]);
  }

  if (extraAmount > 0) {
    amountBreakdown.push([
      'Extra Amount',
      `${extraAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    ]);
  }

  // Add total row to breakdown table
  amountBreakdown.push([
    'Total',
    `${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  ]);

  if (amountBreakdown.length > 0) {
    autoTable(doc, {
      startY: yPos,
      body: amountBreakdown,
      theme: 'grid',
      styles: {
        fontSize: 10,
        cellPadding: 4,
        lineColor: [200, 200, 200],
        lineWidth: 0.5
      },
      columnStyles: {
        0: {
          cellWidth: 80,
          fontStyle: 'bold',
          textColor: [80, 80, 80],
          fillColor: [245, 245, 245]
        },
        1: {
          cellWidth: 'auto',
          halign: 'right',
          textColor: [0, 0, 0],
          fontStyle: 'bold',
          fillColor: [255, 255, 255]
        }
      },
      margin: { left: 15, right: 20 },
      didParseCell: function(data) {
        // Highlight the total row
        if (data.row.index === amountBreakdown.length - 1) {
          data.cell.styles.fillColor = [5, 105, 158];
          data.cell.styles.textColor = [255, 255, 255];
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fontSize = 11;
        }
      }
    });

    yPos = doc.lastAutoTable.finalY + 4;
  }

  yPos +=8;

  // Payment Information
  if (donation.paymentStatus) {
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.setTextColor(5, 105, 158);
    doc.text('Payment Information', 15, yPos);
    yPos += 8;

    const paymentData = [
      [
        'Status:',
        donation.paymentStatus || 'Pending'
      ],
      [
        'Transaction ID:',
        donation.transactionId || 'N/A'
      ]
    ];

    if (donation.paymentMethod) {
      paymentData.push(['Payment Method:', donation.paymentMethod]);
    }

    autoTable(doc, {
      startY: yPos,
      body: paymentData,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 2 },
      columnStyles: {
        0: { cellWidth: 40, fontStyle: 'bold', textColor: [80, 80, 80] },
        1: {
          cellWidth: 'auto',
          textColor: donation.paymentStatus === 'Paid' ? [34, 197, 94] : [0, 0, 0],
          fontStyle: 'bold'
        }
      },
      margin: { left: 15 }
    });

    yPos = doc.lastAutoTable.finalY;
  }

  // Footer
  yPos = doc.internal.pageSize.height - 20;
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.setFont(undefined, 'normal');
  doc.text('Thank you for your generous donation!', pageWidth / 2, yPos, { align: 'center' });

  yPos += 5;
  doc.setFontSize(8);
  doc.text('This is a computer-generated receipt.', pageWidth / 2, yPos, { align: 'center' });

  // Save the PDF
  const fileName = `Donation_Receipt_${donation.transactionId || Date.now()}.pdf`;
  doc.save(fileName);
};

export const generateUserDonationReport = (userGroup, organisationName = 'Donation Report') => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.width;
  const primaryColor = [5, 105, 158];

  // Header with logo and organization name
  doc.setFillColor(...primaryColor);
  doc.rect(0, 0, pageWidth, 45, 'F');

  // Add logo image
  try {
    const logoImg = new Image();
    logoImg.src = '/images/logo.jpg';
    // Add logo - circular frame
    doc.addImage(logoImg, 'JPEG', 12, 10, 20, 20);
  } catch (e) {
    console.log('Logo not loaded:', e);
    // Fallback to placeholder if logo fails to load
    doc.setFillColor(255, 255, 255);
    doc.circle(20, 22, 8, 'F');
    doc.setFillColor(...primaryColor);
    doc.circle(20, 22, 6, 'F');
  }

  // Organization Name
  doc.setFontSize(18);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(organisationName, pageWidth / 2, 18, { align: 'center' });

  // Report Title
  doc.setFontSize(14);
  doc.setFont(undefined, 'normal');
  doc.text('DONATION SUMMARY REPORT', pageWidth / 2, 32, { align: 'center' });

  let yPos = 55;

  // Donor Information
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(...primaryColor);
  doc.text('Donor Information', 15, yPos);
  yPos += 8;

  const donorData = [
    ['Name:', userGroup.userInfo.name],
    ['Email:', userGroup.userInfo.email],
    ['Type:', userGroup.userInfo.type],
    ['Report Date:', new Date().toLocaleDateString('en-IN')]
  ];

  autoTable(doc, {
    startY: yPos,
    body: donorData,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 40, fontStyle: 'bold', textColor: [80, 80, 80] },
      1: { cellWidth: 'auto', textColor: [0, 0, 0] }
    },
    margin: { left: 15 }
  });

  yPos = doc.lastAutoTable.finalY + 12;

  // Summary Statistics
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(...primaryColor);
  doc.text('Summary Statistics', 15, yPos);
  yPos += 8;

  const summaryData = [
    ['Total Donations:', userGroup.totalDonations.toString()],
    ['Total Amount:', `${userGroup.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
    ['Paid Amount:', `${userGroup.paidAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
    ['Pending Amount:', `${userGroup.pendingAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`]
  ];

  autoTable(doc, {
    startY: yPos,
    body: summaryData,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 40, fontStyle: 'bold', textColor: [80, 80, 80] },
      1: { cellWidth: 'auto', halign: 'right', fontStyle: 'bold', textColor: [...primaryColor] }
    },
    margin: { left: 15, right: 15 }
  });

  yPos = doc.lastAutoTable.finalY + 12;

  // Donation History
  doc.setFontSize(12);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(...primaryColor);
  doc.text('Donation History', 15, yPos);
  yPos += 8;

  const tableData = userGroup.donations.map((d, idx) => [
    (idx + 1).toString(),
    new Date(d.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    d.category?.name || 'N/A',
    (d.quantity || 1).toString(),
    `${d.amount ? parseFloat(d.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '0.00'}`,
    d.paymentStatus || 'Pending'
  ]);

  autoTable(doc, {
    startY: yPos,
    head: [['#', 'Date', 'Category', 'Qty', 'Amount', 'Status']],
    body: tableData,
    theme: 'striped',
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: {
      fillColor: primaryColor,
      textColor: [255, 255, 255],
      fontStyle: 'bold'
    },
    columnStyles: {
      0: { cellWidth: 12, halign: 'center' },
      1: { cellWidth: 30 },
      2: { cellWidth: 40 },
      3: { cellWidth: 15, halign: 'center' },
      4: { cellWidth: 35, halign: 'right', fontStyle: 'bold' },
      5: { cellWidth: 25, halign: 'center' }
    },
    margin: { left: 15, right: 15 },
    didParseCell: function(data) {
      if (data.column.index === 5 && data.section === 'body') {
        const status = data.cell.raw;
        if (status === 'Paid') {
          data.cell.styles.textColor = [34, 197, 94];
          data.cell.styles.fontStyle = 'bold';
        } else if (status === 'Failed') {
          data.cell.styles.textColor = [239, 68, 68];
          data.cell.styles.fontStyle = 'bold';
        }
      }
    }
  });

  // Footer
  yPos = doc.internal.pageSize.height - 15;
  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.setFont(undefined, 'normal');
  doc.text('Thank you for your continued support!', pageWidth / 2, yPos, { align: 'center' });

  const fileName = `Donation_Report_${userGroup.userInfo.name.replace(/\s+/g, '_')}_${Date.now()}.pdf`;
  doc.save(fileName);
};

