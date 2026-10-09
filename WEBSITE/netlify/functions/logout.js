const crypto = require("node:crypto");
const { cookieValue, db, fail, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  const expiredCookie = "durva_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    const token = cookieValue(event, "durva_session");
    if (token) {
      const client = db();
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const { error } = await client.from("sessions").delete().eq("token_hash", tokenHash);
      if (error) throw error;
    }
    return response(200, { ok: true }, { "Set-Cookie": expiredCookie });
  } catch (error) {
    const result = fail(error);
    return { ...result, headers: { ...result.headers, "Set-Cookie": expiredCookie } };
  }
};