const crypto = require("node:crypto");
const { assertSameOrigin, db, fail, razorpayRequest, readBody, requireUser, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    assertSameOrigin(event);
    const client = db();
    const user = await requireUser(event, client);
    const data = readBody(event);
    const orderId = String(data.razorpay_order_id || "");
    const paymentId = String(data.razorpay_payment_id || "");
    const signature = String(data.razorpay_signature || "");
    if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-fA-F0-9]{64}$/.test(signature)) {
      return response(400, { error: "Invalid payment verification details." });
    }
    const secret = process.env.RAZORPAY_KEY_SECRET || "";
    const expected = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest();
    const received = Buffer.from(signature, "hex");
    if (!secret || expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      return response(400, { error: "Payment signature could not be verified." });
    }
    const { data: payment, error } = await client.from("payments")
      .select("booking_id,amount,currency,status,gateway_payment_id")
      .eq("gateway_order_id", orderId).eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!payment) return response(404, { error: "Payment order not found." });
    if (payment.status === "paid") {
      if (payment.gateway_payment_id !== paymentId) return response(409, { error: "A different payment already completed this order." });
      return response(200, { ok: true, bookingId: payment.booking_id });
    }
    const providerPayment = await razorpayRequest("GET", `payments/${paymentId}`);
    if (providerPayment.order_id !== orderId || providerPayment.status !== "captured" ||
        providerPayment.amount !== payment.amount * 100 || providerPayment.currency !== "INR") {
      return response(400, { error: "Payment is not captured for this booking." });
    }
    const { error: paymentError } = await client.from("payments").update({
      gateway_payment_id: paymentId, status: "paid", paid_at: new Date().toISOString()
    }).eq("gateway_order_id", orderId).eq("user_id", user.id).eq("status", "pending");
    if (paymentError) throw paymentError;
    const { error: bookingError } = await client.from("bookings").update({ status: "confirmed" })
      .eq("id", payment.booking_id).eq("user_id", user.id).eq("status", "pending");
    if (bookingError) throw bookingError;
    return response(200, { ok: true, bookingId: payment.booking_id });
  } catch (error) { return fail(error); }
};