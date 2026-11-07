import React from 'react';
import { Button, formatCurrencyVND } from '@kido/admin-ui';
import { generateVietQrImageUrl } from '@kido/payment-vietqr';
import { Printer, X, QrCode } from 'lucide-react';
import type { AdminOrder, BankConfig } from '../../types';

export interface ReceiptModalProps {
  order: AdminOrder | null;
  isOpen: boolean;
  onClose: () => void;
  storeName?: string;
  storeTagline?: string;
  storeHotline?: string;
  storeAddress?: string;
  bankConfig?: BankConfig;
  exchangeRate?: number;
}

export function ReceiptModal({
  order,
  isOpen,
  onClose,
  storeName = 'E-COMMERCE STORE',
  storeTagline = 'Official Sales & Fulfillment Center',
  storeHotline = '1900 6868',
  storeAddress = 'Vietnam',
  bankConfig = {
    bank: 'MBBank',
    accountNumber: '0912345678',
    accountName: 'KIDO ECOMMERCE',
    template: 'compact2',
  },
  exchangeRate = 25400,
}: ReceiptModalProps) {
  if (!isOpen || !order) return null;

  const totalVnd = Math.round(order.totalAmount * exchangeRate);
  const isVietQr = order.paymentMethod.toLowerCase().includes('vietqr');

  // Generate dynamic VietQR image URL using @kido/payment-vietqr
  let vietQrImageUrl = '';
  try {
    vietQrImageUrl = generateVietQrImageUrl({
      bank: bankConfig.bank,
      accountNumber: bankConfig.accountNumber,
      accountName: bankConfig.accountName,
      amount: totalVnd,
      description: `DH ${order.id.slice(-6).toUpperCase()}`,
      template: bankConfig.template || 'compact2',
    });
  } catch {
    // Fallback if bank resolution fails
    vietQrImageUrl = `https://img.vietqr.io/image/MB-0912345678-compact2.png?amount=${totalVnd}&addInfo=DH%20${order.id.slice(-6).toUpperCase()}`;
  }

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      {/* Print-specific style injection to isolate receipt */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          #k80-print-receipt, #k80-print-receipt * {
            visibility: visible;
          }
          #k80-print-receipt {
            position: absolute;
            left: 0;
            top: 0;
            width: 80mm !important;
            margin: 0 !important;
            padding: 4mm !important;
            box-shadow: none !important;
            border: none !important;
            background: white !important;
            color: black !important;
            font-size: 11px !important;
          }
        }
      `}</style>

      <div className="relative w-full max-w-sm bg-white border border-slate-300 rounded-2xl shadow-2xl p-5 overflow-hidden flex flex-col my-auto">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Printer className="size-4 text-orange-600" />
            <span className="font-bold text-sm text-slate-900">
              Hóa Đơn In Nhiệt K80 (80mm)
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Printable Thermal Receipt Card */}
        <div
          id="k80-print-receipt"
          className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-black text-left font-mono text-[11px] leading-tight my-4 shadow-inner"
        >
          {/* Store Brand */}
          <div className="text-center font-bold text-sm border-b border-slate-300 pb-2 mb-2">
            <div className="tracking-wide uppercase text-slate-900">{storeName}</div>
            <div className="text-[10px] font-normal text-slate-600 mt-0.5">
              {storeTagline}
            </div>
            <div className="text-[9px] font-normal text-slate-500">
              Hotline: {storeHotline} • {storeAddress}
            </div>
          </div>

          {/* Order Metadata */}
          <div className="space-y-0.5 text-[10.5px]">
            <div>
              <span className="font-semibold">Mã đơn #:</span>{' '}
              <span className="font-bold">{order.id}</span>
            </div>
            <div>
              <span className="font-semibold">Thời gian:</span>{' '}
              {new Date(order.createdAt).toLocaleDateString('vi-VN')}{' '}
              {new Date(order.createdAt).toLocaleTimeString('vi-VN')}
            </div>
            <div>
              <span className="font-semibold">Khách hàng:</span>{' '}
              {order.customer.name}
            </div>
            <div>
              <span className="font-semibold">Điện thoại:</span>{' '}
              {order.customer.phone || 'N/A'}
            </div>
            {order.customer.address && (
              <div>
                <span className="font-semibold">Địa chỉ:</span>{' '}
                {order.customer.address}, {order.customer.city || ''}
              </div>
            )}
            <div>
              <span className="font-semibold">Phương thức:</span>{' '}
              {isVietQr ? 'VietQR Chuyển Khoản 24/7' : order.paymentMethod.toUpperCase()}
            </div>
            {order.paymentRef && (
              <div>
                <span className="font-semibold">Mã GD:</span> {order.paymentRef}
              </div>
            )}
          </div>

          {/* Itemized Lines */}
          <div className="border-t border-dashed border-slate-400 my-2 pt-1.5" />
          <div className="flex justify-between font-bold text-[11px]">
            <span>{order.tierName || `Gói x${order.quantity} sản phẩm`}</span>
            <span>${order.subtotal.toFixed(2)}</span>
          </div>

          {/* Variants / Slots */}
          {order.slots && order.slots.length > 0 && (
            <div className="text-[10px] text-slate-600 pl-2 my-1 space-y-0.5">
              {order.slots.map((slot, idx) => (
                <div key={idx}>
                  #{idx + 1}: {slot.variantName || slot.selectedVariantId}
                </div>
              ))}
            </div>
          )}

          {/* Fees & Discounts */}
          <div className="border-t border-slate-300 my-1.5 pt-1 space-y-0.5 text-[10px] text-slate-600">
            <div className="flex justify-between">
              <span>Phí vận chuyển:</span>
              <span>{order.shippingFee === 0 ? 'MIỄN PHÍ' : `$${order.shippingFee.toFixed(2)}`}</span>
            </div>
            {order.discountAmount && order.discountAmount > 0 ? (
              <div className="flex justify-between text-rose-600">
                <span>Giảm giá:</span>
                <span>-${order.discountAmount.toFixed(2)}</span>
              </div>
            ) : null}
          </div>

          {/* Totals */}
          <div className="border-t border-double border-slate-400 mt-2 pt-1.5 space-y-1">
            <div className="flex justify-between font-bold text-xs">
              <span>TỔNG CỘNG (USD):</span>
              <span className="text-sm">${order.totalAmount.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-xs text-emerald-800">
              <span>QUY ĐỔI (VND):</span>
              <span>{formatCurrencyVND(totalVnd)}</span>
            </div>
          </div>

          {/* Dynamic VietQR Payment Code Section */}
          <div className="mt-3 pt-2 border-t border-slate-300 text-center">
            <div className="flex items-center justify-center gap-1 text-[10px] font-bold text-teal-800 mb-1">
              <QrCode className="size-3 text-teal-600" />
              <span>QUÉT MÃ VIETQR ĐỂ THANH TOÁN</span>
            </div>
            <div className="bg-white p-1 rounded-lg border border-slate-200 inline-block shadow-2xs">
              <img
                src={vietQrImageUrl}
                alt="VietQR Payment Code"
                className="w-48 h-auto mx-auto object-contain"
                loading="lazy"
              />
            </div>
            <div className="text-[9px] text-slate-500 mt-1">
              Ngân hàng: {bankConfig.bank} • STK: {bankConfig.accountNumber}
              <br />
              Chủ TK: {bankConfig.accountName}
            </div>
          </div>

          {/* Footer note */}
          <div className="text-center text-[9px] mt-3 pt-1 border-t border-dashed border-slate-300 text-slate-500">
            Cảm ơn quý khách! Vui lòng giữ hóa đơn để bảo hành.
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2">
          <Button
            variant="default"
            onClick={handlePrint}
            className="flex-1 bg-slate-900 hover:bg-black text-white text-xs gap-1.5 cursor-pointer"
          >
            <Printer className="size-3.5" /> In Hóa Đơn K80
          </Button>
          <Button
            variant="outline"
            onClick={onClose}
            className="flex-1 text-xs cursor-pointer"
          >
            Đóng
          </Button>
        </div>
      </div>
    </div>
  );
}
