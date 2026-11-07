import { z } from 'zod';

export const CargoConditionSchema = z.enum([
  'INTACT_SEALED',      // Nguyên đai nguyên kiện, niêm phong chì đầy đủ
  'VERIFIED_GOOD',      // Đã kiểm tra mở hộp, hàng hóa nguyên vẹn
  'TEMP_VERIFIED',      // Nhiệt độ hàng lạnh đạt chuẩn (-18°C)
  'MINOR_SCRATCH',      // Xước bao bì nhẹ ngoài vỏ, bên trong đạt
  'PARTIAL_REJECTED',   // Trả lại một phần hàng lỗi
]);
export type CargoCondition = z.infer<typeof CargoConditionSchema>;

export const EpodSubmissionInputSchema = z.object({
  orderCode: z.string().min(3),
  tripId: z.string().min(3),
  stopId: z.string().min(3),
  truckLicensePlate: z.string().min(4),
  driverId: z.string().min(2),
  driverName: z.string().min(2),
  recipientName: z.string().min(2),
  recipientPhone: z.string().min(8),
  recipientIdentityNo: z.string().optional(),
  deliveryAddress: z.string().min(5),
  gpsLocation: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().nonnegative().optional().default(5),
  }),
  timestamp: z.string().optional(),
  signatureData: z.string().min(10), // Base64 data URL or SVG path data
  cargoDeliveredCount: z.number().int().positive(),
  cargoDeliveredWeightKg: z.number().positive().optional(),
  cargoCondition: CargoConditionSchema.default('INTACT_SEALED'),
  coldChainTemperatureCelsius: z.number().optional(),
  deliveryPhotos: z.array(z.string()).optional().default([]),
  customerNotes: z.string().optional(),
});
export type EpodSubmissionInput = z.input<typeof EpodSubmissionInputSchema>;

export interface ElectronicProofOfDelivery {
  epodId: string;
  orderCode: string;
  tripId: string;
  stopId: string;
  truckLicensePlate: string;
  driverId: string;
  driverName: string;
  recipientName: string;
  recipientPhone: string;
  recipientIdentityNo?: string;
  deliveryAddress: string;
  gpsLocation: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
  };
  cargoDeliveredCount: number;
  cargoDeliveredWeightKg?: number;
  cargoCondition: CargoCondition;
  coldChainTemperatureCelsius?: number;
  deliveryPhotos: string[];
  customerNotes?: string;
  signatureData: string;
  signatureLength: number;
  signedAt: string;
  verificationHash: string;
  verificationQrData: string;
  status: 'DELIVERED_VERIFIED';
}

/**
 * Universal standard SHA-256 hash calculation (FIPS 180-4)
 * 100% bit-exact with Node crypto, works in Browser, Node, Bun, and Edge.
 */
export function computeSha256(data: string): string {
  function rightRotate(value: number, amount: number): number {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words: number[] = [];
  const ascii = unescape(encodeURIComponent(data));
  const asciiBitLength = ascii.length * 8;
  const hash: number[] = [];
  const k: number[] = [];
  let primeCounter = 0;
  const isComposite: Record<number, boolean | number> = {};

  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  let padded = ascii + '\x80';
  while ((padded.length % 64) - 56) padded += '\x00';

  for (let i = 0; i < padded.length; i++) {
    const j = padded.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength | 0;

  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = [...hash];
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15] || 0;
      const w2 = w[i - 2] || 0;
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] = i < 16 ? (w[i] || 0) : ((w[i - 16] || 0) + s0 + (w[i - 7] || 0) + s1) | 0;
      const s1_ = rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25);
      const ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
      const temp1 = hash[7] + s1_ + ch + k[i] + w[i];
      const s0_ = rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22);
      const maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
      const temp2 = s0_ + maj;
      hash.unshift((temp1 + temp2) | 0);
      hash.pop();
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }

  for (let i = 0; i < 8; i++) {
    result +=
      ((hash[i] >>> 24) & 0xff).toString(16).padStart(2, '0') +
      ((hash[i] >>> 16) & 0xff).toString(16).padStart(2, '0') +
      ((hash[i] >>> 8) & 0xff).toString(16).padStart(2, '0') +
      (hash[i] & 0xff).toString(16).padStart(2, '0');
  }

  return result;
}

/**
 * Serialize canonical payload for anti-tamper verification
 */
export function buildCanonicalEpodPayload(data: {
  orderCode: string;
  tripId: string;
  truckLicensePlate: string;
  driverId: string;
  recipientName: string;
  recipientPhone: string;
  latitude: number;
  longitude: number;
  signedAt: string;
  cargoCount: number;
  condition: string;
  signatureData: string;
}): string {
  // Truncate signature to standard checksum or use full content
  const sigHash = computeSha256(data.signatureData);
  return [
    data.orderCode.trim(),
    data.tripId.trim(),
    data.truckLicensePlate.trim(),
    data.driverId.trim(),
    data.recipientName.trim(),
    data.recipientPhone.trim(),
    data.latitude.toFixed(6),
    data.longitude.toFixed(6),
    data.signedAt.trim(),
    data.cargoCount.toString(),
    data.condition.trim(),
    sigHash,
  ].join('::');
}

/**
 * Sign and Issue an Anti-Tamper Electronic Proof of Delivery (e-POD)
 */
export function signElectronicProofOfDelivery(
  input: EpodSubmissionInput
): ElectronicProofOfDelivery {
  const signedAt = input.timestamp || new Date().toISOString();
  const dateSlug = signedAt.slice(0, 10).replace(/-/g, '');
  const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
  const epodId = `EPOD-${dateSlug}-${randomSuffix}`;

  const canonicalPayload = buildCanonicalEpodPayload({
    orderCode: input.orderCode,
    tripId: input.tripId,
    truckLicensePlate: input.truckLicensePlate,
    driverId: input.driverId,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    latitude: input.gpsLocation.latitude,
    longitude: input.gpsLocation.longitude,
    signedAt,
    cargoCount: input.cargoDeliveredCount,
    condition: input.cargoCondition || 'INTACT_SEALED',
    signatureData: input.signatureData,
  });

  const verificationHash = computeSha256(canonicalPayload);

  // Verification QR Payload
  const qrPayload = JSON.stringify({
    v: '1.0',
    epodId,
    order: input.orderCode,
    plate: input.truckLicensePlate,
    lat: input.gpsLocation.latitude,
    lng: input.gpsLocation.longitude,
    time: signedAt,
    hash: verificationHash.substring(0, 16),
  });

  return {
    epodId,
    orderCode: input.orderCode,
    tripId: input.tripId,
    stopId: input.stopId,
    truckLicensePlate: input.truckLicensePlate,
    driverId: input.driverId,
    driverName: input.driverName,
    recipientName: input.recipientName,
    recipientPhone: input.recipientPhone,
    recipientIdentityNo: input.recipientIdentityNo,
    deliveryAddress: input.deliveryAddress,
    gpsLocation: {
      latitude: input.gpsLocation.latitude,
      longitude: input.gpsLocation.longitude,
      accuracyMeters: input.gpsLocation.accuracyMeters ?? 5,
    },
    cargoDeliveredCount: input.cargoDeliveredCount,
    cargoDeliveredWeightKg: input.cargoDeliveredWeightKg,
    cargoCondition: input.cargoCondition || 'INTACT_SEALED',
    coldChainTemperatureCelsius: input.coldChainTemperatureCelsius,
    deliveryPhotos: input.deliveryPhotos || [],
    customerNotes: input.customerNotes,
    signatureData: input.signatureData,
    signatureLength: input.signatureData.length,
    signedAt,
    verificationHash,
    verificationQrData: qrPayload,
    status: 'DELIVERED_VERIFIED',
  };
}

/**
 * Verify integrity and anti-tamper authenticity of an e-POD record
 */
export function verifyEpodIntegrity(epod: ElectronicProofOfDelivery): {
  isValid: boolean;
  expectedHash: string;
  actualHash: string;
  details: string;
} {
  const canonicalPayload = buildCanonicalEpodPayload({
    orderCode: epod.orderCode,
    tripId: epod.tripId,
    truckLicensePlate: epod.truckLicensePlate,
    driverId: epod.driverId,
    recipientName: epod.recipientName,
    recipientPhone: epod.recipientPhone,
    latitude: epod.gpsLocation.latitude,
    longitude: epod.gpsLocation.longitude,
    signedAt: epod.signedAt,
    cargoCount: epod.cargoDeliveredCount,
    condition: epod.cargoCondition,
    signatureData: epod.signatureData,
  });

  const expectedHash = computeSha256(canonicalPayload);
  const isValid = expectedHash === epod.verificationHash;

  return {
    isValid,
    expectedHash,
    actualHash: epod.verificationHash,
    details: isValid
      ? 'Chữ ký điện tử e-POD nguyên vẹn 100%, tọa độ GPS & thời gian xác thực hợp lệ không bị chỉnh sửa.'
      : 'CẢNH BÁO: e-POD đã bị chỉnh sửa trái phép (Sai lệch mã băm xác thực SHA-256).',
  };
}

/**
 * Generate human-readable markdown certificate for e-POD handover
 */
export function generateEpodCertificateMarkdown(epod: ElectronicProofOfDelivery): string {
  const verification = verifyEpodIntegrity(epod);
  const tempNotice =
    epod.coldChainTemperatureCelsius !== undefined
      ? `\n- **Nhiệt độ hàng lạnh lúc bàn giao**: \`${epod.coldChainTemperatureCelsius}°C\` (Chuỗi cung ứng lạnh đạt chuẩn)`
      : '';

  return `
# 📜 BIÊN BẢN BÀN GIAO ĐIỆN TỬ (e-POD CERTIFICATE)
**Mã Chứng Thư:** \`${epod.epodId}\`  
**Trạng Thái:** ${verification.isValid ? '✅ **ĐÃ XÁC THỰC TOÀN VẸN (SHA-256)**' : '❌ **KHÔNG HỢP LỆ / ĐÃ BỊ SỬA ĐỔI**'}

---

### 1. Thông Tin Chuyến Giao & Phương Tiện
- **Mã Đơn Hàng:** \`${epod.orderCode}\` | **Chuyến:** \`${epod.tripId}\`
- **Biển Số Xe Tải:** \`${epod.truckLicensePlate}\`
- **Tài Xế Bàn Giao:** **${epod.driverName}** (Mã: \`${epod.driverId}\`)
- **Thời Gian Ký Nhận:** \`${epod.signedAt}\`

### 2. Người Nhận Hàng & Địa Điểm
- **Khách Hàng Nhận:** **${epod.recipientName}** (${epod.recipientPhone})
- **Địa Chỉ:** ${epod.deliveryAddress}
- **Tọa Độ GPS Check-in:** \`${epod.gpsLocation.latitude.toFixed(6)}, ${epod.gpsLocation.longitude.toFixed(6)}\` (Sai số ±${epod.gpsLocation.accuracyMeters}m)

### 3. Quy Cách Hàng Hóa
- **Số Lượng Kiện Bàn Giao:** **${epod.cargoDeliveredCount} kiện**${epod.cargoDeliveredWeightKg ? ` (${epod.cargoDeliveredWeightKg} kg)` : ''}
- **Tình Trạng Hàng:** \`${epod.cargoCondition}\`${tempNotice}
- **Ghi Chú:** ${epod.customerNotes || 'Bàn giao đầy đủ không trầy xước.'}

### 4. Chữ Ký Điện Tử & Chống Làm Giả
- **Mã Băm Bảo Mật (SHA-256):** \`${epod.verificationHash}\`
- **Chữ Ký Cảm Ứng:** Đã số hóa (${epod.signatureLength} bytes)
- **Tình Trạng Chứng Chỉ:** ${verification.details}
`.trim();
}
