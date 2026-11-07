import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Invoice } from './types';

/**
 * Escape các ký tự đặc biệt trong XML
 */
export function escapeXml(unsafe: string | number | undefined | null): string {
  if (unsafe === undefined || unsafe === null) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Sinh cấu trúc XML Hóa đơn Điện tử theo Thông tư 78/2021/TT-BTC & Quyết định 1450/QĐ-TCT
 */
export function buildInvoiceXml(invoice: Invoice, dataId: string = 'data-invoice'): string {
  const invoiceTypeNames: Record<number, string> = {
    1: 'Hóa đơn giá trị gia tăng',
    2: 'Hóa đơn bán hàng',
    3: 'Hóa đơn bán tài sản công',
    4: 'Hóa đơn bán hàng dự trữ quốc gia',
    5: 'Hóa đơn khác',
    6: 'Chứng từ xuất kho',
  };

  const invoiceTypeName = invoiceTypeNames[invoice.invoiceType] || 'Hóa đơn điện tử';

  const itemsXml = invoice.items
    .map(
      (item) => `      <HHDVu>
        <STT>${item.lineNumber}</STT>
        <TChat>${item.itemType}</TChat>${item.itemCode ? `\n        <MHHDVu>${escapeXml(item.itemCode)}</MHHDVu>` : ''}
        <THHDVu>${escapeXml(item.itemName)}</THHDVu>
        <DVT>${escapeXml(item.unit)}</DVT>
        <SLuong>${item.quantity}</SLuong>
        <DGia>${item.unitPrice}</DGia>${item.discountRate ? `\n        <TLCKhau>${item.discountRate}</TLCKhau>` : ''}${item.discountAmount ? `\n        <STCKhau>${item.discountAmount}</STCKhau>` : ''}
        <TSuat>${escapeXml(item.vatRate)}</TSuat>
        <ThTien>${item.amount}</ThTien>
      </HHDVu>`
    )
    .join('\n');

  const vatSummariesXml = invoice.taxSummary.vatSummaries
    .map(
      (v) => `        <LTSuat>
          <TSuat>${escapeXml(v.vatRate)}</TSuat>
          <ThTien>${v.taxableAmount}</ThTien>
          <TThue>${v.vatAmount}</TThue>
        </LTSuat>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<HDon>
  <DLHDon Id="${dataId}">
    <TTChung>
      <PBan>2.0.0</PBan>
      <THDon>${escapeXml(invoiceTypeName)}</THDon>
      <KHMSHDon>${invoice.invoiceType}</KHMSHDon>
      <KHHDon>${escapeXml(invoice.invoiceSeries)}</KHHDon>
      <SHDon>${escapeXml(invoice.invoiceNumber)}</SHDon>
      <NLap>${escapeXml(invoice.issuedDate)}</NLap>
      <DVTTe>${escapeXml(invoice.currency)}</DVTTe>
      <TGia>${invoice.exchangeRate}</TGia>
      <HTTToan>${escapeXml(invoice.paymentMethod)}</HTTToan>
    </TTChung>
    <NBan>
      <Ten>${escapeXml(invoice.seller.sellerName)}</Ten>
      <MST>${escapeXml(invoice.seller.sellerTaxCode)}</MST>
      <DChi>${escapeXml(invoice.seller.sellerAddress)}</DChi>${invoice.seller.sellerPhone ? `\n      <SDThoai>${escapeXml(invoice.seller.sellerPhone)}</SDThoai>` : ''}${invoice.seller.sellerEmail ? `\n      <DCTDTu>${escapeXml(invoice.seller.sellerEmail)}</DCTDTu>` : ''}${invoice.seller.sellerBankAccount ? `\n      <STKNHang>${escapeXml(invoice.seller.sellerBankAccount)}</STKNHang>` : ''}${invoice.seller.sellerBankName ? `\n      <TNHang>${escapeXml(invoice.seller.sellerBankName)}</TNHang>` : ''}
    </NBan>
    <NMua>
      <Ten>${escapeXml(invoice.buyer.buyerName)}</Ten>${invoice.buyer.buyerLegalName ? `\n      <TenDonVi>${escapeXml(invoice.buyer.buyerLegalName)}</TenDonVi>` : ''}${invoice.buyer.buyerTaxCode ? `\n      <MST>${escapeXml(invoice.buyer.buyerTaxCode)}</MST>` : ''}${invoice.buyer.buyerAddress ? `\n      <DChi>${escapeXml(invoice.buyer.buyerAddress)}</DChi>` : ''}${invoice.buyer.buyerEmail ? `\n      <DCTDTu>${escapeXml(invoice.buyer.buyerEmail)}</DCTDTu>` : ''}${invoice.buyer.buyerPhone ? `\n      <SDThoai>${escapeXml(invoice.buyer.buyerPhone)}</SDThoai>` : ''}
    </NMua>
    <DSHHDVu>
${itemsXml}
    </DSHHDVu>
    <TToan>
      <THTTLTSuat>
${vatSummariesXml}
      </THTTLTSuat>
      <TgTCThue>${invoice.taxSummary.totalUntaxedAmount}</TgTCThue>
      <TgTThue>${invoice.taxSummary.totalVatAmount}</TgTThue>
      <TgTTTBSo>${invoice.taxSummary.totalAmount}</TgTTTBSo>
      <TgTTTBChu>${escapeXml(invoice.taxSummary.amountInWords)}</TgTTTBChu>
    </TToan>
  </DLHDon>
</HDon>`;
}

/**
 * Chuẩn hóa XML (C14N canonicalization tối giản nhưng chuẩn xác)
 */
export function canonicalizeXml(xml: string): string {
  // Loại bỏ khai báo XML declaration
  let res = xml.replace(/<\?xml[^>]*\?>/g, '').trim();

  // Chuẩn hóa line breaks
  res = res.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Sắp xếp các attributes theo thứ tự bảng chữ cái trong từng thẻ mở
  res = res.replace(/<([a-zA-Z0-9_:\-]+)([^>]*)>/g, (match, tagName, attrsStr) => {
    if (!attrsStr.trim() || attrsStr.startsWith('/')) return match;
    const isSelfClosing = attrsStr.endsWith('/');
    const cleanAttrsStr = isSelfClosing ? attrsStr.slice(0, -1) : attrsStr;
    const attrRegex = /([a-zA-Z0-9_:\-]+)="([^"]*)"/g;
    const attrs: { name: string; value: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(cleanAttrsStr)) !== null) {
      attrs.push({ name: m[1], value: m[2] });
    }
    if (attrs.length === 0) return match;
    attrs.sort((a, b) => a.name.localeCompare(b.name));
    const sortedAttrsStr = attrs.map((a) => `${a.name}="${a.value}"`).join(' ');
    return `<${tagName} ${sortedAttrsStr}${isSelfClosing ? '/>' : '>'}`;
  });

  return res;
}

/**
 * Tính giá trị SHA-256 Digest của chuỗi XML và mã hóa Base64
 */
export function computeXmlDigest(xmlContent: string): string {
  return crypto.createHash('sha256').update(xmlContent, 'utf8').digest('base64');
}

export interface SignXmlOptions {
  xml: string;
  privateKeyPem: string;
  certificatePem: string;
  elementId?: string;
  signatureId?: string;
}

export interface SignedXmlResult {
  signedXml: string;
  digestValue: string;
  signatureValue: string;
  certificate: string;
}

/**
 * Ký số điện tử vào tài liệu XML Hóa đơn theo chuẩn W3C XML Signature Enveloped
 */
export function signInvoiceXml(options: SignXmlOptions): SignedXmlResult {
  const elementId = options.elementId || 'data-invoice';
  const signatureId = options.signatureId || 'seller-signature';

  // 1. Trích xuất phần tử cần ký (ví dụ <DLHDon Id="data-invoice">...</DLHDon>)
  const startPattern = new RegExp(`<([a-zA-Z0-9_:\\-]+)[^>]*\\bId=["']${elementId}["'][^>]*>`);
  const match = startPattern.exec(options.xml);
  if (!match) {
    throw new Error(`Không tìm thấy phần tử có Id="${elementId}" trong XML để ký`);
  }

  const tagName = match[1];
  const startIndex = match.index;
  const endTag = `</${tagName}>`;
  const endIndex = options.xml.indexOf(endTag, startIndex);
  if (endIndex === -1) {
    throw new Error(`Không tìm thấy thẻ đóng </${tagName}> của phần tử Id="${elementId}"`);
  }

  const rawElement = options.xml.slice(startIndex, endIndex + endTag.length);
  const canonicalElement = canonicalizeXml(rawElement);

  // 2. Tính DigestValue của phần tử dữ liệu
  const digestValue = computeXmlDigest(canonicalElement);

  // 3. Xây dựng SignedInfo
  const signedInfoRaw = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
    <ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
    <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
    <ds:Reference URI="#${elementId}">
      <ds:Transforms>
        <ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>
      </ds:Transforms>
      <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
      <ds:DigestValue>${digestValue}</ds:DigestValue>
    </ds:Reference>
  </ds:SignedInfo>`;

  const canonicalSignedInfo = canonicalizeXml(signedInfoRaw);

  // 4. Ký SignedInfo bằng RSA-SHA256
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(canonicalSignedInfo, 'utf8');
  const signatureValue = signer.sign(options.privateKeyPem, 'base64');

  // 5. Chuẩn hóa chứng thư số X509 (bỏ header/footer và dòng trắng)
  const certBase64 = options.certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');

  // 6. Xây dựng khối chữ ký số XMLDSig
  const signatureBlock = `  <DSCKS>
    <NBan>
      <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${signatureId}">
        ${signedInfoRaw.trim()}
        <ds:SignatureValue>${signatureValue}</ds:SignatureValue>
        <ds:KeyInfo>
          <ds:X509Data>
            <ds:X509Certificate>${certBase64}</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </ds:Signature>
    </NBan>
  </DSCKS>`;

  // 7. Chèn DSCKS vào trước thẻ đóng </HDon>
  let signedXml: string;
  if (options.xml.includes('</HDon>')) {
    signedXml = options.xml.replace('</HDon>', `${signatureBlock}\n</HDon>`);
  } else {
    signedXml = `${options.xml}\n${signatureBlock}`;
  }

  return {
    signedXml,
    digestValue,
    signatureValue,
    certificate: certBase64,
  };
}

export interface VerifySignatureResult {
  valid: boolean;
  digestValid: boolean;
  signatureValid: boolean;
  certificate?: string;
  error?: string;
}

/**
 * Kiểm tra tính hợp lệ của chữ ký số XML (Digest và Chữ ký RSA-SHA256)
 */
export function verifyInvoiceXmlSignature(
  signedXml: string,
  options?: {
    publicKeyPem?: string;
    certPem?: string;
  }
): VerifySignatureResult {
  try {
    // 1. Trích xuất DigestValue từ <ds:DigestValue>
    const digestMatch = /<ds:DigestValue>([^<]+)<\/ds:DigestValue>/.exec(signedXml);
    if (!digestMatch) {
      return { valid: false, digestValid: false, signatureValid: false, error: 'Không tìm thấy thẻ ds:DigestValue' };
    }
    const expectedDigest = digestMatch[1].trim();

    // 2. Trích xuất Reference URI
    const refMatch = /<ds:Reference\s+URI=["']#?([^"']+)["']/.exec(signedXml);
    if (!refMatch) {
      return { valid: false, digestValid: false, signatureValid: false, error: 'Không tìm thấy Reference URI trong Signature' };
    }
    const targetId = refMatch[1].trim();

    // 3. Trích xuất phần tử dữ liệu gốc theo targetId
    const startPattern = new RegExp(`<([a-zA-Z0-9_:\\-]+)[^>]*\\bId=["']${targetId}["'][^>]*>`);
    const match = startPattern.exec(signedXml);
    if (!match) {
      return { valid: false, digestValid: false, signatureValid: false, error: `Không tìm thấy phần tử mục tiêu Id="${targetId}"` };
    }

    const tagName = match[1];
    const startIndex = match.index;
    const endTag = `</${tagName}>`;
    const endIndex = signedXml.indexOf(endTag, startIndex);
    if (endIndex === -1) {
      return { valid: false, digestValid: false, signatureValid: false, error: `Thẻ đóng </${tagName}> không hợp lệ` };
    }

    const targetElement = signedXml.slice(startIndex, endIndex + endTag.length);
    const computedDigest = computeXmlDigest(canonicalizeXml(targetElement));

    const digestValid = computedDigest === expectedDigest;
    if (!digestValid) {
      return {
        valid: false,
        digestValid: false,
        signatureValid: false,
        error: `Dữ liệu hóa đơn đã bị chỉnh sửa sau khi ký (Digest mismatch: tính được ${computedDigest}, trong chữ ký là ${expectedDigest})`,
      };
    }

    // 4. Trích xuất SignedInfo
    const signedInfoMatch = /<ds:SignedInfo[\s\S]*?<\/ds:SignedInfo>/.exec(signedXml);
    if (!signedInfoMatch) {
      return { valid: false, digestValid: true, signatureValid: false, error: 'Không tìm thấy thẻ ds:SignedInfo' };
    }
    const rawSignedInfo = signedInfoMatch[0];
    const canonicalSignedInfo = canonicalizeXml(rawSignedInfo);

    // 5. Trích xuất SignatureValue
    const sigValueMatch = /<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/.exec(signedXml);
    if (!sigValueMatch) {
      return { valid: false, digestValid: true, signatureValid: false, error: 'Không tìm thấy ds:SignatureValue' };
    }
    const signatureValue = sigValueMatch[1].trim();

    // 6. Lấy Public Key (từ tham số truyền vào hoặc trích từ ds:X509Certificate)
    let publicKey = options?.publicKeyPem;
    let certBase64: string | undefined;

    if (!publicKey) {
      if (options?.certPem) {
        const certObj = new crypto.X509Certificate(options.certPem);
        publicKey = certObj.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      } else {
        const certMatch = /<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/.exec(signedXml);
        if (certMatch) {
          certBase64 = certMatch[1].replace(/\s+/g, '');
          const certPemFormatted = `-----BEGIN CERTIFICATE-----\n${certBase64.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----`;
          const certObj = new crypto.X509Certificate(certPemFormatted);
          publicKey = certObj.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        }
      }
    }

    if (!publicKey) {
      return { valid: false, digestValid: true, signatureValid: false, error: 'Không tìm thấy chứng thư số hoặc khóa công khai để xác minh' };
    }

    // 7. Xác minh chữ ký RSA-SHA256 trên canonicalSignedInfo
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(canonicalSignedInfo, 'utf8');
    const signatureValid = verifier.verify(publicKey, signatureValue, 'base64');

    return {
      valid: digestValid && signatureValid,
      digestValid,
      signatureValid,
      certificate: certBase64,
    };
  } catch (err) {
    return {
      valid: false,
      digestValid: false,
      signatureValid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Sinh cặp khóa RSA 2048-bit và chứng thư số X.509 tự ký (dùng cho Sandbox / Testing)
 */
export function generateSelfSignedCert(options?: {
  commonName?: string;
  org?: string;
  taxCode?: string;
  days?: number;
}): { privateKeyPem: string; certificatePem: string; publicKeyPem: string } {
  const commonName = options?.commonName || 'CÔNG TY TNHH CÔNG NGHỆ KHÁNH TÂM';
  const org = options?.org || 'KT Technology';
  const days = options?.days || 365;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'einvoice-cert-'));
  const keyPath = path.join(tempDir, 'key.pem');
  const certPath = path.join(tempDir, 'cert.pem');

  try {
    const subj = `/CN=${commonName}/O=${org}/C=VN`;
    execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days ${days} -subj "${subj}"`, {
      stdio: 'ignore',
    });

    const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    const certificatePem = fs.readFileSync(certPath, 'utf8');
    const x509 = new crypto.X509Certificate(certificatePem);
    const publicKeyPem = x509.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    return { privateKeyPem, certificatePem, publicKeyPem };
  } finally {
    try {
      if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
      if (fs.existsSync(certPath)) fs.unlinkSync(certPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    } catch {
      // ignore cleanup errors
    }
  }
}
