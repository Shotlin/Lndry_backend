function normalizeTimelineType(rawTimelineType) {
  const normalized = `${rawTimelineType || ''}`.trim().toUpperCase()
  if (!normalized) {
    return 'ORDER_STATUS'
  }
  if (normalized === 'OUT_FOR_DELIVERY') {
    return 'PICKED_UP'
  }
  return normalized
}

export function buildCustomerOrderEventNotification({
  orderId,
  orderNumber,
  timelineType,
  status,
}) {
  const normalizedTimelineType = normalizeTimelineType(timelineType)
  const normalizedStatus = `${status || ''}`.trim().toUpperCase()

  const messageMap = {
    ORDER_PLACED: {
      title: '🛍️ Order placed',
      body: `Your order ${orderNumber} was placed successfully. We will keep you updated here.`,
    },
    RIDER_ACCEPTED: {
      title: '🛵 Rider accepted your order',
      body: `A delivery partner accepted order ${orderNumber}. Please wait a few minutes while they get ready.`,
    },
    PICKED_UP: {
      title: '📦 Your order is on the way',
      body: `Order ${orderNumber} has been picked up and is now heading to you.`,
    },
    DELIVERED: {
      title: '✅ Delivered successfully',
      body: `Order ${orderNumber} has been delivered. Enjoy your purchase.`,
    },
  }

  const fallback = {
    title: '📣 Order update',
    body: `There is a new update for order ${orderNumber}.`,
  }

  const message = messageMap[normalizedTimelineType] || fallback

  return {
    title: message.title,
    body: message.body,
    type: 'ORDER_STATUS',
    data: {
      type: 'ORDER_STATUS',
      orderId,
      orderNumber,
      timelineType: normalizedTimelineType,
      status: normalizedStatus,
    },
  }
}
