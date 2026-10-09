const crypto = require("node:crypto");
const { db, fail, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return response(503, { error: "Webhook secret is not configured." });
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || "", "base64") : Buffer.from(event.body || "", "utf8");
    if (rawBody.length < 1 || rawBody.length > 64000) return response(400, { error: "Invalid webhook size." });
    const signature = event.headers?.["x-razorpay-signature"] || event.headers?.["X-Razorpay-Signature"] || "";
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
    const received = Buffer.from(signature, "hex");
    if (!signature || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return response(400, { error: "Invalid webhook signature." });
    }
    const eventData = JSON.parse(rawBody.toString("utf8"));
    const payment = eventData.payload?.payment?.entity;
    if (!payment?.order_id || !payment?.id) return response(200, { ok: true });
    const client = db();
    const { data: stored, error } = await client.from("payments")
      .select("booking_id,amount,currency,status").eq("gateway_order_id", payment.order_id).maybeSingle();
    if (error) throw error;
    if (!stored || stored.status !== "pending") return response(200, { ok: true });
    if (eventData.event === "payment.captured") {
      if (payment.amount !== stored.amount * 100 || payment.currency !== stored.currency) return response(400, { error: "Payment amount mismatch." });
      const { error: paymentError } = await client.from("payments").update({
        gateway_payment_id: payment.id, status: "paid", paid_at: new Date().toISOString()
      }).eq("gateway_order_id", payment.order_id).eq("status", "pending");
      if (paymentError) throw paymentError;
      const { error: bookingError } = await client.from("bookings").update({ status: "confirmed" })
        .eq("id", stored.booking_id).eq("status", "pending");
      if (bookingError) throw bookingError;
    } else if (eventData.event === "payment.failed") {
      const { error: paymentError } = await client.from("payments").update({
        gateway_payment_id: payment.id, status: "failed"
      }).eq("gateway_order_id", payment.order_id).eq("status", "pending");
      if (paymentError) throw paymentError;
      const { error: bookingError } = await client.from("bookings").update({ status: "failed" })
        .eq("id", stored.booking_id).eq("status", "pending");
      if (bookingError) throw bookingError;
    }
    return response(200, { ok: true });
  } catch (error) { return fail(error); }
};