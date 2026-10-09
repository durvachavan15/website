const crypto = require("node:crypto");
const { assertSameOrigin, createSession, db, fail, passwordHash, readBody, response } = require("./_shared.cjs");

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return response(405, { error: "Method not allowed." }, { Allow: "POST" });
    assertSameOrigin(event);
    const data = readBody(event);
    const email = String(data.email || "").trim().toLowerCase();
    const password = String(data.password || "");
    const client = db();
    const { data: user, error } = await client.from("users")
      .select("id,name,email,password_salt,password_hash").eq("email", email).maybeSingle();
    if (error) throw error;
    let valid = false;
    if (user && password.length <= 128) {
      const { hash } = await passwordHash(password, user.password_salt);
      const actual = Buffer.from(hash, "hex");
      const expected = Buffer.from(user.password_hash, "hex");
      valid = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    if (!valid) return response(401, { error: "Email or password is incorrect." });
    const cookie = await createSession(client, user.id);
    return response(200, { user: { name: user.name, email: user.email } }, { "Set-Cookie": cookie });
  } catch (error) { return fail(error); }
};