import {
  GearItem,
  RentalBooking,
  HandoverInspection,
  HandoverItemReport,
  GearCondition,
  HandoverAuditInput,
  HandoverInspectionSchema,
} from './types';

export const DEFAULT_ACCESSORY_PENALTY_VND = 200_000; // 200,000 VND default per missing accessory

/**
 * Formats a number into Vietnamese Dong currency string (e.g. 1,500,000 VND).
 */
export function formatVND(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Handover Audit Service handles equipment inspection during show dispatch (Check-Out)
 * and recovery return (Check-In), calculating compensation for damaged or missing gear and accessories,
 * and generating formatted K80 thermal receipts.
 */
export class HandoverAuditService {
  /**
   * Generates a Check-Out handover inspection record when gears leave warehouse for a show.
   */
  public static createCheckOutInspection(
    input: HandoverAuditInput
  ): HandoverInspection {
    const { booking, gears, inspectorName, customerRepresentative } = input;
    const items: HandoverItemReport[] = [];

    for (const gid of booking.gearIds) {
      const gear = gears.find((g) => g.id === gid);
      items.push({
        gearId: gid,
        gearName: gear?.name || gid,
        condition: 'PRISTINE',
        missingAccessories: [],
        accessoryPenaltyFee: 0,
        damagePenaltyFee: 0,
        totalPenaltyFee: 0,
      });
    }

    const inspectionId = `HO-OUT-${Date.now()}`;
    const timestamp = new Date();

    const inspectionData = HandoverInspectionSchema.parse({
      id: inspectionId,
      bookingId: booking.id,
      type: 'CHECK_OUT',
      timestamp,
      inspectorName,
      customerRepresentative,
      items,
      totalPenaltyFee: 0,
    });

    const k80ReceiptText = this.formatK80Receipt(
      inspectionData,
      booking,
      gears
    );
    inspectionData.k80ReceiptText = k80ReceiptText;

    return inspectionData;
  }

  /**
   * Generates a Check-In handover inspection record when gears return to warehouse,
   * calculating penalty fees for damaged items or lost accessories.
   */
  public static createCheckInInspection(
    input: HandoverAuditInput
  ): HandoverInspection {
    const {
      booking,
      gears,
      inspectorName,
      customerRepresentative,
      itemAudits = [],
    } = input;
    const items: HandoverItemReport[] = [];
    let overallPenaltyFee = 0;

    for (const gid of booking.gearIds) {
      const gear = gears.find((g) => g.id === gid);
      const audit = itemAudits.find((a) => a.gearId === gid);

      const condition: GearCondition = audit?.condition || 'PRISTINE';
      const missingAccessories = audit?.missingAccessories || [];
      const damageNote = audit?.damageNote;

      // 1. Calculate missing accessory penalties
      let accessoryPenaltyFee = 0;
      if (missingAccessories.length > 0) {
        for (const acc of missingAccessories) {
          const specificCost = gear?.accessoryCosts?.[acc];
          accessoryPenaltyFee +=
            specificCost !== undefined
              ? specificCost
              : DEFAULT_ACCESSORY_PENALTY_VND;
        }
      }

      // 2. Calculate damage penalty
      let damagePenaltyFee = 0;
      const replacementValue = gear?.replacementValue || 0;

      if (audit?.damageCost !== undefined) {
        damagePenaltyFee = audit.damageCost;
      } else {
        switch (condition) {
          case 'MISSING':
            damagePenaltyFee = replacementValue;
            break;
          case 'DAMAGED':
            damagePenaltyFee = Math.round(replacementValue * 0.5);
            break;
          case 'SCRATCHED':
            damagePenaltyFee = Math.round(replacementValue * 0.1);
            break;
          case 'PRISTINE':
          case 'GOOD':
          default:
            damagePenaltyFee = 0;
            break;
        }
      }

      const itemTotalPenalty = accessoryPenaltyFee + damagePenaltyFee;
      overallPenaltyFee += itemTotalPenalty;

      items.push({
        gearId: gid,
        gearName: gear?.name || gid,
        condition,
        missingAccessories,
        damageNote,
        accessoryPenaltyFee,
        damagePenaltyFee,
        totalPenaltyFee: itemTotalPenalty,
      });
    }

    const inspectionId = `HO-IN-${Date.now()}`;
    const timestamp = new Date();

    const inspectionData = HandoverInspectionSchema.parse({
      id: inspectionId,
      bookingId: booking.id,
      type: 'CHECK_IN',
      timestamp,
      inspectorName,
      customerRepresentative,
      items,
      totalPenaltyFee: overallPenaltyFee,
    });

    const k80ReceiptText = this.formatK80Receipt(
      inspectionData,
      booking,
      gears
    );
    inspectionData.k80ReceiptText = k80ReceiptText;

    return inspectionData;
  }

  /**
   * Generates a thermal-printer friendly (K80 format - ~40 columns) text receipt.
   */
  public static formatK80Receipt(
    inspection: HandoverInspection,
    booking: RentalBooking,
    gears: GearItem[]
  ): string {
    const isOut = inspection.type === 'CHECK_OUT';
    const title = isOut
      ? 'BIÊN BẢN BÀN GIAO THIẾT BỊ (CHECK-OUT)'
      : 'BIÊN BẢN THU HỒI THIẾT BỊ (CHECK-IN)';

    const padCenter = (str: string, width: number = 42) => {
      const padLen = Math.max(0, width - str.length);
      const leftPad = Math.floor(padLen / 2);
      return ' '.repeat(leftPad) + str;
    };

    const lines: string[] = [];
    lines.push('==========================================');
    lines.push(padCenter('T-RED MEDIA & PHOTOBOOTH'));
    lines.push(padCenter('tred.vn | fotobooth.vn'));
    lines.push(padCenter(`KHO: ${booking.location}`));
    lines.push('------------------------------------------');
    lines.push(padCenter(title));
    lines.push('------------------------------------------');
    lines.push(`Mã biên bản: ${inspection.id}`);
    lines.push(`Mã booking : ${booking.id}`);
    if (booking.eventName) {
      lines.push(`Sự kiện    : ${booking.eventName}`);
    }
    lines.push(`Khách hàng : ${booking.customerName}`);
    lines.push(`Đại diện KH: ${inspection.customerRepresentative}`);
    lines.push(`Kỹ thuật   : ${inspection.inspectorName}`);
    lines.push(
      `Thời gian  : ${new Date(inspection.timestamp).toLocaleString('vi-VN')}`
    );
    lines.push('==========================================');
    lines.push('DANH MỤC THIẾT BỊ & PHỤ KIỆN:');

    let idx = 1;
    for (const item of inspection.items) {
      const gear = gears.find((g) => g.id === item.gearId);
      const gearName = gear?.name || item.gearId;
      const serial = gear?.serialNumber || 'N/A';

      lines.push(`\n${idx}. ${gearName}`);
      lines.push(`   S/N: ${serial} | TT: [${item.condition}]`);

      if (gear?.standardAccessories && gear.standardAccessories.length > 0) {
        lines.push(
          `   Phụ kiện: ${gear.standardAccessories.join(', ')}`
        );
      }

      if (item.missingAccessories.length > 0) {
        lines.push(
          `   (!) MẤT PHỤ KIỆN: ${item.missingAccessories.join(', ')}`
        );
        lines.push(
          `       Phạt mất PK: ${formatVND(item.accessoryPenaltyFee)}`
        );
      }

      if (item.damageNote) {
        lines.push(`   (!) Ghi chú hư tổn: ${item.damageNote}`);
      }

      if (item.damagePenaltyFee > 0) {
        lines.push(
          `       Phạt hư hại: ${formatVND(item.damagePenaltyFee)}`
        );
      }

      if (item.totalPenaltyFee > 0) {
        lines.push(
          `   => Tổng phạt máy: ${formatVND(item.totalPenaltyFee)}`
        );
      }

      idx++;
    }

    lines.push('\n==========================================');
    if (!isOut) {
      lines.push(
        `TỔNG TIỀN BỒI THƯỜNG: ${formatVND(inspection.totalPenaltyFee)}`
      );
      lines.push('==========================================');
    }

    lines.push('\nCAM KẾT & XÁC NHẬN:');
    lines.push('Hai bên đã kiểm tra đúng số lượng, tình trạng');
    lines.push('thiết bị và thống nhất các nội dung ghi nhận.');
    lines.push('\n   BÊN GIAO                     BÊN NHẬN');
    lines.push('  (Ký, ghi rõ họ tên)         (Ký, ghi rõ họ tên)\n\n\n');
    lines.push('==========================================');
    lines.push(padCenter('Hotline hỗ trợ kỹ thuật: 0905.XXX.XXX'));
    lines.push('==========================================');

    return lines.join('\n');
  }
}
