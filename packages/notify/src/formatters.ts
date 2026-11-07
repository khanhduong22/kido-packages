import {
  AppointmentNotificationPayload,
  OrderNotificationPayload,
  StayBookingNotificationPayload,
  SystemAlertPayload,
} from './types';

/**
 * Format currency to Vietnamese Dong (e.g. 150.000 ₫)
 */
export function formatMoneyVND(amount: number): string {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
  }).format(amount);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode
 */
export function escapeHtml(str?: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Escape MarkdownV2 characters for Telegram MarkdownV2 parse mode
 */
export function escapeMarkdownV2(str: string): string {
  if (!str) return '';
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Formats a clean date string
 */
function formatDate(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return String(date);

  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  return `${hours}:${minutes} - ${day}/${month}/${year}`;
}

/**
 * Formats Order Notification into beautiful HTML message for Telegram
 */
export function formatOrderNotificationHtml(payload: OrderNotificationPayload): string {
  const title = escapeHtml(payload.appTitle || 'FAST FOOD EXPRESS');
  const orderId = escapeHtml(payload.orderId);
  const customerName = escapeHtml(payload.customerName);
  const phone = escapeHtml(payload.phone);
  const totalStr = formatMoneyVND(payload.totalAmount);
  const timeStr = formatDate(payload.createdAt);

  const statusBadge =
    payload.paymentStatus === 'PAID'
      ? '✅ <b>ĐÃ THANH TOÁN (VIETQR)</b>'
      : payload.paymentStatus === 'FAILED'
        ? '❌ <b>THANH TOÁN THẤT BẠI</b>'
        : '⏳ <b>CHỜ THANH TOÁN</b>';

  let itemsList = '';
  for (const item of payload.items) {
    const itemTotal = formatMoneyVND(item.price * item.quantity);
    itemsList += `• ${item.quantity}x <b>${escapeHtml(item.name)}</b> (${itemTotal})\n`;
  }

  let text = `🛒 <b>[${title}] ĐƠN HÀNG MỚI #${orderId}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👤 <b>Khách hàng:</b> ${customerName}\n`;
  text += `📞 <b>Điện thoại:</b> <a href="tel:${phone}">${phone}</a>\n`;

  if (payload.deliveryAddress) {
    text += `📍 <b>Địa chỉ:</b> ${escapeHtml(payload.deliveryAddress)}\n`;
  }

  text += `\n📦 <b>Chi tiết món:</b>\n${itemsList}`;
  text += `\n💰 <b>Tổng tiền:</b> <b>${totalStr}</b>\n`;
  text += `💳 <b>Trạng thái:</b> ${statusBadge}\n`;

  if (payload.note) {
    text += `📝 <b>Ghi chú:</b> <i>${escapeHtml(payload.note)}</i>\n`;
  }

  text += `⏰ <b>Thời gian:</b> ${timeStr}\n`;
  return text;
}

/**
 * Formats Appointment Notification into beautiful HTML message for Telegram
 */
export function formatAppointmentNotificationHtml(payload: AppointmentNotificationPayload): string {
  const title = escapeHtml(payload.appTitle || 'SPA & CLINIC');
  const appointmentId = escapeHtml(payload.appointmentId);
  const customerName = escapeHtml(payload.customerName);
  const phone = escapeHtml(payload.phone);
  const service = escapeHtml(payload.serviceName);
  const staff = payload.staffName ? escapeHtml(payload.staffName) : 'Kỹ thuật viên ngẫu nhiên';
  const totalStr = formatMoneyVND(payload.totalAmount);
  const appTime = formatDate(payload.appointmentTime);

  let depositBadge = 'Chưa yêu cầu cọc';
  if (payload.depositAmount && payload.depositAmount > 0) {
    const depositStr = formatMoneyVND(payload.depositAmount);
    if (payload.depositStatus === 'PAID') {
      depositBadge = `✅ Đã cọc <b>${depositStr}</b> (VietQR)`;
    } else {
      depositBadge = `⏳ Chờ cọc <b>${depositStr}</b>`;
    }
  }

  let text = `🌸 <b>[${title}] LỊCH HẸN MỚI #${appointmentId}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👤 <b>Khách hàng:</b> ${customerName}\n`;
  text += `📞 <b>Số điện thoại:</b> <a href="tel:${phone}">${phone}</a>\n`;
  text += `💆‍♀️ <b>Dịch vụ:</b> <b>${service}</b>\n`;
  text += `👩‍⚕️ <b>Chuyên viên:</b> ${staff}\n`;
  text += `⏰ <b>Giờ hẹn:</b> <b>${appTime}</b>\n`;

  if (payload.branch) {
    text += `🏢 <b>Chi nhánh:</b> ${escapeHtml(payload.branch)}\n`;
  }

  text += `\n💰 <b>Tổng chi phí:</b> <b>${totalStr}</b>\n`;
  text += `💵 <b>Đặt cọc:</b> ${depositBadge}\n`;

  if (payload.note) {
    text += `📝 <b>Ghi chú:</b> <i>${escapeHtml(payload.note)}</i>\n`;
  }

  return text;
}

/**
 * Formats Stay/Villa Direct Booking Notification into beautiful HTML message for Telegram
 */
export function formatStayBookingTelegramHtml(payload: StayBookingNotificationPayload): string {
  const title = escapeHtml(payload.appTitle || 'PINE FOREST RETREAT VILLA');
  const code = escapeHtml(payload.bookingCode);
  const customerName = escapeHtml(payload.customerName);
  const phone = escapeHtml(payload.phone);
  const room = escapeHtml(payload.roomName);
  const checkIn = escapeHtml(payload.checkInDate);
  const checkOut = escapeHtml(payload.checkOutDate);
  const nights = payload.nights;
  const adults = payload.guests.adults;
  const children = payload.guests.children || 0;
  const totalStr = formatMoneyVND(payload.totalAmount);
  const depositStr = formatMoneyVND(payload.depositAmount);
  const smartLockPin = escapeHtml(payload.smartLockPin);

  let extrasList = '';
  if (payload.extraServices && payload.extraServices.length > 0) {
    for (const extra of payload.extraServices) {
      extrasList += `• ${escapeHtml(extra.name)}: ${formatMoneyVND(extra.price)}\n`;
    }
  }

  let text = `🏡 <b>[${title}] ĐẶT PHÒNG DIRECT #${code}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👤 <b>Khách hàng:</b> ${customerName}\n`;
  text += `📞 <b>Số điện thoại:</b> <a href="tel:${phone}">${phone}</a>\n`;
  if (payload.email) {
    text += `✉️ <b>Email:</b> ${escapeHtml(payload.email)}\n`;
  }
  text += `🏡 <b>Căn / Phòng:</b> <b>${room}</b>\n`;
  text += `📅 <b>Lịch trình:</b> ${checkIn} ➔ ${checkOut} (<b>${nights} đêm</b>)\n`;
  text += `👥 <b>Số khách:</b> ${adults} người lớn${children > 0 ? `, ${children} trẻ em` : ''}\n`;

  if (extrasList) {
    text += `\n✨ <b>Gói dịch vụ thêm:</b>\n${extrasList}`;
  }

  text += `\n💰 <b>Tổng tiền:</b> <b>${totalStr}</b> (0% phí sàn)\n`;
  text += `💳 <b>Tiền cọc (50%):</b> <b>${depositStr}</b> (VietQR)\n`;
  text += `🔐 <b>MÃ SMART LOCK PIN:</b> <code>${smartLockPin}</code>\n`;

  if (payload.wifiPassword) {
    text += `📶 <b>WiFi:</b> <code>${escapeHtml(payload.wifiSsid || 'Villa-Pine-Guest')}</code> (Pass: <code>${escapeHtml(payload.wifiPassword)}</code>)\n`;
  }

  if (payload.note) {
    text += `📝 <b>Ghi chú:</b> <i>${escapeHtml(payload.note)}</i>\n`;
  }

  return text;
}

/**
 * Formats System Error / Alert into beautiful HTML message for Telegram
 */
export function formatSystemAlertHtml(payload: SystemAlertPayload): string {
  const icon =
    payload.level === 'CRITICAL'
      ? '🚨'
      : payload.level === 'ERROR'
        ? '❌'
        : payload.level === 'WARN'
          ? '⚠️'
          : 'ℹ️';

  const service = escapeHtml(payload.service.toUpperCase());
  const title = escapeHtml(payload.title);
  const message = escapeHtml(payload.message);
  const time = formatDate(payload.timestamp);

  let text = `${icon} <b>[${payload.level}] BÁO ĐỘNG HỆ THỐNG: ${service}</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `⚠️ <b>Sự cố:</b> <b>${title}</b>\n`;
  text += `📄 <b>Mô tả:</b> ${message}\n`;
  text += `⏰ <b>Thời điểm:</b> ${time}\n`;

  if (payload.context && Object.keys(payload.context).length > 0) {
    const jsonContext = JSON.stringify(payload.context, null, 2);
    text += `\n🔍 <b>Context Data:</b>\n<pre>${escapeHtml(jsonContext)}</pre>\n`;
  }

  if (payload.stack) {
    const shortStack = payload.stack.split('\n').slice(0, 5).join('\n');
    text += `\n📍 <b>Stack Trace:</b>\n<pre>${escapeHtml(shortStack)}</pre>\n`;
  }

  return text;
}
