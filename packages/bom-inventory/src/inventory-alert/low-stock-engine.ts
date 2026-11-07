import { evaluateInventoryExpiry } from './expiry-evaluator';
import {
  AlertSeverity,
  NotifySystemAlertPayload,
  StockAlertPayload,
  StockAlertPayloadSchema,
  StockInventory,
  StockStatus,
} from './types';

export interface LowStockEvaluationOptions {
  referenceDate?: Date | string;
  appTitle?: string;
  generateTelegramHtml?: boolean;
}

/**
 * Escapes HTML characters for Telegram HTML parse mode.
 */
function escapeHtml(str: string): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Formats a clean date string (HH:mm - DD/MM/YYYY)
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
 * Formats a StockAlertPayload into a Telegram HTML message.
 */
export function formatStockAlertTelegramHtml(
  alert: StockAlertPayload,
  appTitle: string = 'KHO HÀNG & BẾP TRUNG TÂM'
): string {
  const statusIcon =
    alert.stockStatus === 'OUT_OF_STOCK'
      ? '🚨'
      : alert.stockStatus === 'CRITICAL_LOW'
        ? '🔴'
        : alert.stockStatus === 'LOW_STOCK'
          ? '⚠️'
          : '🟢';

  const statusLabel =
    alert.stockStatus === 'OUT_OF_STOCK'
      ? 'HẾT HÀNG TRONG KHO (0 KHẢ DỤNG)'
      : alert.stockStatus === 'CRITICAL_LOW'
        ? 'BÁO ĐỘNG ĐỎ - SẮP CẠN KIỆT'
        : alert.stockStatus === 'LOW_STOCK'
          ? 'TỒN KHO DƯỚI MỨC AN TOÀN'
          : 'TỒN KHO ỔN ĐỊNH';

  const timeStr = formatDate(alert.timestamp);
  const pName = escapeHtml(alert.productName);
  const pUnit = escapeHtml(alert.unit);
  const sku = alert.sku ? ` (SKU: ${escapeHtml(alert.sku)})` : '';

  let text = `${statusIcon} <b>[${escapeHtml(appTitle)}] CẢNH BÁO TỒN KHO</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📦 <b>Sản phẩm:</b> <b>${pName}</b>${sku}\n`;
  text += `📊 <b>Trạng thái:</b> <b>${statusLabel}</b>\n`;
  text += `🔢 <b>Tồn khả dụng:</b> <b>${alert.usableStock} ${pUnit}</b>\n`;
  text += `🎯 <b>Mức an toàn tối thiểu:</b> ${alert.minStockThreshold} ${pUnit}\n`;

  if (alert.expiredStock > 0) {
    text += `❌ <b>Hàng đã quá hạn:</b> <b>${alert.expiredStock} ${pUnit}</b> (Cần tiêu hủy)\n`;
  }

  if (alert.expiringBatchesCount > 0) {
    text += `⏳ <b>Lô sắp hết hạn:</b> <b>${alert.expiringBatchesCount} lô</b> (Ưu tiên bán/chế biến trước)\n`;
  }

  if (alert.recommendedReorderQty > 0) {
    text += `🚚 <b>Đề xuất nhập thêm:</b> <b>+${alert.recommendedReorderQty} ${pUnit}</b>\n`;
  }

  text += `📝 <b>Chi tiết:</b> ${escapeHtml(alert.message)}\n`;
  text += `⏰ <b>Thời điểm kiểm tra:</b> ${timeStr}\n`;

  return text;
}

/**
 * Converts a StockAlertPayload into @kido/notify compatible SystemAlertPayload.
 */
export function toNotifySystemAlert(
  alert: StockAlertPayload,
  serviceName: string = 'INVENTORY_ALERT'
): NotifySystemAlertPayload {
  return {
    service: serviceName,
    title: `[${alert.severity}] Cảnh báo tồn kho: ${alert.productName}`,
    message: alert.message,
    level: alert.severity,
    context: {
      alertId: alert.alertId,
      productId: alert.productId,
      productName: alert.productName,
      sku: alert.sku,
      category: alert.category,
      unit: alert.unit,
      currentStock: alert.currentStock,
      usableStock: alert.usableStock,
      expiredStock: alert.expiredStock,
      minStockThreshold: alert.minStockThreshold,
      criticalThreshold: alert.criticalThreshold,
      stockStatus: alert.stockStatus,
      expiringBatchesCount: alert.expiringBatchesCount,
      recommendedReorderQty: alert.recommendedReorderQty,
      telegramHtml: alert.telegramHtml,
    },
    timestamp: alert.timestamp,
  };
}

/**
 * Evaluates stock level for a single inventory item and generates StockAlertPayload.
 */
export function evaluateStockLevel(
  inventory: StockInventory,
  options: LowStockEvaluationOptions = {}
): StockAlertPayload {
  const referenceDate = options.referenceDate ? new Date(options.referenceDate) : new Date();

  // Evaluate batches to separate unexpired (usable) from expired
  const expiryEval = evaluateInventoryExpiry(inventory.batches || [], {
    referenceDate,
  });

  const usableStock = expiryEval.stats.totalUsableQty;
  const expiredStock = expiryEval.stats.totalExpiredQty;
  const currentStock = usableStock + expiredStock;

  const minThreshold = inventory.minStockThreshold;
  const criticalThreshold =
    inventory.criticalThreshold !== undefined
      ? inventory.criticalThreshold
      : Math.max(1, Math.round(minThreshold * 0.25));

  let stockStatus: StockStatus;
  let severity: AlertSeverity;
  let message: string;

  if (usableStock <= 0) {
    stockStatus = 'OUT_OF_STOCK';
    severity = 'CRITICAL';
    message = `Sản phẩm "${inventory.productName}" đã HẾT HÀNG khả dụng (0 ${inventory.unit}). Cần nhập gấp!`;
  } else if (usableStock <= criticalThreshold) {
    stockStatus = 'CRITICAL_LOW';
    severity = 'ERROR';
    message = `Sản phẩm "${inventory.productName}" đang ở mức NGUY HIỂM (${usableStock}/${minThreshold} ${inventory.unit}).`;
  } else if (usableStock <= minThreshold) {
    stockStatus = 'LOW_STOCK';
    severity = 'WARN';
    message = `Sản phẩm "${inventory.productName}" dưới mức tối thiểu (${usableStock}/${minThreshold} ${inventory.unit}). Cần lên đơn nhập.`;
  } else {
    stockStatus = 'OPTIMAL';
    severity = 'INFO';
    message = `Tồn kho sản phẩm "${inventory.productName}" đang ở mức an toàn (${usableStock} ${inventory.unit}).`;
  }

  // Calculate recommended reorder quantity
  const targetStock = inventory.reorderQuantity
    ? usableStock + inventory.reorderQuantity
    : minThreshold * 2;
  const recommendedReorderQty = Math.max(0, targetStock - usableStock);

  const alertId = `ALERT-${inventory.productId}-${Date.now()}`;

  const payload: StockAlertPayload = {
    alertId,
    productId: inventory.productId,
    productName: inventory.productName,
    sku: inventory.sku,
    category: inventory.category,
    unit: inventory.unit,
    currentStock,
    usableStock,
    expiredStock,
    minStockThreshold: minThreshold,
    criticalThreshold,
    stockStatus,
    expiringBatchesCount: expiryEval.expiringSoonBatches.length,
    recommendedReorderQty,
    severity,
    message,
    timestamp: referenceDate,
  };

  if (options.generateTelegramHtml !== false) {
    payload.telegramHtml = formatStockAlertTelegramHtml(payload, options.appTitle);
  }

  // Validate output conforms to schema
  return StockAlertPayloadSchema.parse(payload);
}

/**
 * Evaluates an entire list of inventory items and returns all alerts requiring attention.
 */
export function scanInventoryForAlerts(
  inventories: StockInventory[],
  options: LowStockEvaluationOptions = {}
): {
  allAlerts: StockAlertPayload[];
  attentionRequired: StockAlertPayload[];
  criticalAlerts: StockAlertPayload[];
} {
  const allAlerts: StockAlertPayload[] = [];
  const attentionRequired: StockAlertPayload[] = [];
  const criticalAlerts: StockAlertPayload[] = [];

  for (const inv of inventories) {
    const alert = evaluateStockLevel(inv, options);
    allAlerts.push(alert);

    if (alert.stockStatus !== 'OPTIMAL' || alert.expiringBatchesCount > 0 || alert.expiredStock > 0) {
      attentionRequired.push(alert);
    }

    if (alert.severity === 'CRITICAL' || alert.severity === 'ERROR') {
      criticalAlerts.push(alert);
    }
  }

  return {
    allAlerts,
    attentionRequired,
    criticalAlerts,
  };
}
