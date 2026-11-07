import assert from 'node:assert';
import test from 'node:test';
import {
  formatAppointmentNotificationHtml,
  formatMoneyVND,
  formatOrderNotificationHtml,
  formatStayBookingTelegramHtml,
  formatSystemAlertHtml,
} from './index';

test('formatMoneyVND formats numbers to Vietnamese currency', () => {
  const result = formatMoneyVND(150000);
  assert.ok(result.includes('150.000'));
  assert.ok(result.includes('₫') || result.includes('VND'));
});

test('formatOrderNotificationHtml generates clean HTML with itemized list', () => {
  const html = formatOrderNotificationHtml({
    orderId: 'FF-10023',
    customerName: 'Nguyễn Văn A',
    phone: '0987654321',
    deliveryAddress: '123 Đường Số 1, Quận 1, TP.HCM',
    items: [
      { name: 'Gà Giòn Cay 2 miếng', quantity: 2, price: 70000 },
      { name: 'Khoai Tây Chiên Vừa', quantity: 1, price: 25000 },
    ],
    totalAmount: 165000,
    paymentMethod: 'VIETQR',
    paymentStatus: 'PAID',
    note: 'Xin thêm tương cà và tương ớt',
  });

  assert.ok(html.includes('ĐƠN HÀNG MỚI #FF-10023'));
  assert.ok(html.includes('Nguyễn Văn A'));
  assert.ok(html.includes('0987654321'));
  assert.ok(html.includes('Gà Giòn Cay 2 miếng'));
  assert.ok(html.includes('Khoai Tây Chiên Vừa'));
  assert.ok(html.includes('ĐÃ THANH TOÁN (VIETQR)'));
  assert.ok(html.includes('Xin thêm tương cà'));
});

test('formatAppointmentNotificationHtml generates clean appointment message', () => {
  const html = formatAppointmentNotificationHtml({
    appointmentId: 'SPA-8899',
    customerName: 'Trần Thị B',
    phone: '0912345678',
    serviceName: 'Chăm sóc da chuyên sâu 90 phút',
    staffName: 'Master Lan Anh',
    appointmentTime: '2026-10-01T14:30:00Z',
    branch: 'Chi nhánh Quận 3',
    totalAmount: 500000,
    depositAmount: 100000,
    depositStatus: 'PAID',
    note: 'Khách có tiền sử dị ứng mỹ phẩm cồn',
  });

  assert.ok(html.includes('LỊCH HẸN MỚI #SPA-8899'));
  assert.ok(html.includes('Trần Thị B'));
  assert.ok(html.includes('0912345678'));
  assert.ok(html.includes('Chăm sóc da chuyên sâu'));
  assert.ok(html.includes('Master Lan Anh'));
  assert.ok(html.includes('Chi nhánh Quận 3'));
  assert.ok(html.includes('Đã cọc'));
});

test('formatSystemAlertHtml formats system alert with code block', () => {
  const html = formatSystemAlertHtml({
    service: 'api-gateway',
    title: 'Database connection pool exhausted',
    message: 'Too many concurrent queries on PostgreSQL master',
    level: 'CRITICAL',
    context: { activeConnections: 100, maxConnections: 100 },
    stack: 'Error: Connection timeout\n    at Pool.connect (/app/db.ts:42)',
  });

  assert.ok(html.includes('🚨 <b>[CRITICAL] BÁO ĐỘNG HỆ THỐNG: API-GATEWAY</b>'));
  assert.ok(html.includes('Database connection pool exhausted'));
  assert.ok(html.includes('<pre>'));
  assert.ok(html.includes('activeConnections'));
});

test('formatStayBookingTelegramHtml formats homestay/villa booking with smart lock PIN and VietQR deposit', () => {
  const html = formatStayBookingTelegramHtml({
    bookingId: 'stay-1234',
    bookingCode: 'STAY-9988',
    customerName: 'Hoàng Hải Yến',
    phone: '0933221100',
    email: 'yen.hoang@gmail.com',
    roomName: 'Villa Thung Lũng Mây (2 Phòng Ngủ)',
    checkInDate: '2026-11-10',
    checkOutDate: '2026-11-12',
    nights: 2,
    guests: { adults: 4, children: 1 },
    extraServices: [
      { name: 'Tiệc BBQ sân vườn', price: 700000 },
      { name: 'Đốt lửa trại & kẹo nướng', price: 200000 },
    ],
    totalAmount: 5900000,
    depositAmount: 2950000,
    depositStatus: 'PENDING',
    smartLockPin: '582910#',
    wifiSsid: 'Villa-Cloud-Valley',
    wifiPassword: 'retreatpine2026',
    note: 'Chuẩn bị thêm 1 nôi em bé',
  });

  assert.ok(html.includes('STAY-9988'));
  assert.ok(html.includes('Hoàng Hải Yến'));
  assert.ok(html.includes('Villa Thung Lũng Mây'));
  assert.ok(html.includes('582910#'));
  assert.ok(html.includes('Tiệc BBQ'));
  assert.ok(html.includes('retreatpine2026'));
  assert.ok(html.includes('2 đêm'));
});

