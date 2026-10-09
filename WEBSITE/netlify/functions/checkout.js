const crypto = require("node:crypto");
const { assertSameOrigin, db, fail, nowIso, readBody, razorpayRequest, requireUser, response, vehicles } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    assertSameOrigin(event);
    const client = db();
    const user = await requireUser(event, client);
    const data = readBody(event);
    const vehicleId = String(data.vehicleId || "");
    if (!vehicles[vehicleId]) return response(400, { error: "Choose a valid vehicle." });
    const start = String(data.start || "");
    const end = String(data.end || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return response(400, { error: "Enter valid pickup and return dates." });
    }
    const startDate = new Date(`${start}T00:00:00.000Z`);
    const endDate = new Date(`${end}T00:00:00.000Z`);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate.toISOString().slice(0, 10) !== start || endDate.toISOString().slice(0, 10) !== end) {
      return response(400, { error: "Enter valid pickup and return dates." });
    }
    const days = Math.round((endDate - startDate) / 86400000);
    if (start < new Date().toISOString().slice(0, 10) || days < 1 || days > 30) {
      return response(400, { error: "Rental dates must be today or later and between 1 and 30 days apart." });
    }
    const driver = data.driver === true;
    const helmet = data.helmet === true;
    const [name, dailyPrice, city] = vehicles[vehicleId];
    const extras = (driver ? 1200 * days : 0) + (helmet ? 99 : 0);
    const subtotal = dailyPrice * days + 299 * days + extras;
    const total = subtotal + Math.floor((subtotal * 18 + 50) / 100);
    const bookingId = `DV${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
    const order = await razorpayRequest("POST", "orders", {
      amount: total * 100, currency: "INR", receipt: bookingId,
      notes: { booking_id: bookingId, user_id: user.id }
    });
    const booking = await client.from("bookings").insert({
      id: bookingId, user_id: user.id, vehicle_id: vehicleId, vehicle_name: name, city,
      start_date: start, end_date: end, days, driver, helmet, total, status: "pending", created_at: nowIso()
    });
    if (booking.error) throw booking.error;
    const payment = await client.from("payments").insert({
      user_id: user.id, booking_id: bookingId, gateway_order_id: order.id,
      amount: total, currency: "INR", status: "pending", created_at: nowIso()
    });
    if (payment.error) {
      await client.from("bookings").delete().eq("id", bookingId).eq("user_id", user.id);
      throw payment.error;
    }
    return response(200, {
      keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount,
      currency: order.currency, bookingId, name, email: user.email, customerName: user.name
    });
  } catch (error) { return fail(error); }
};