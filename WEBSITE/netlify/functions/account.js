const { db, fail, requireUser, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "GET") return response(405, { error: "Method not allowed." }, { Allow: "GET" });
    const client = db();
    const user = await requireUser(event, client);
    const [bookings, payments] = await Promise.all([
      client.from("bookings").select("id,vehicle_id,vehicle_name,city,start_date,end_date,days,total,status")
        .eq("user_id", user.id).eq("status", "confirmed").order("start_date", { ascending: false }),
      client.from("payments").select("booking_id,gateway_payment_id,amount,currency,status,created_at,paid_at")
        .eq("user_id", user.id).order("created_at", { ascending: false })
    ]);
    if (bookings.error) throw bookings.error;
    if (payments.error) throw payments.error;
    return response(200, {
      bookings: bookings.data.map((item) => ({
        id: item.id, vehicleId: item.vehicle_id, name: item.vehicle_name, city: item.city,
        start: item.start_date, end: item.end_date, days: item.days, total: item.total, status: item.status
      })),
      payments: payments.data.map((item) => ({
        bookingId: item.booking_id, paymentId: item.gateway_payment_id, total: item.amount,
        currency: item.currency, status: item.status, createdAt: item.created_at, paidAt: item.paid_at
      }))
    });
  } catch (error) { return fail(error); }
};