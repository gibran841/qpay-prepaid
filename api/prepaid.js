
const crypto = require("crypto");

const FACILITATOR = "https://useqpay.com/facilitator";
const PRICE = "1000";
const DEPOSIT = "10000";
const RESOURCE = "/api/prepaid";

function b64url(data) {
  return Buffer.from(data).toString("base64url");
}

function makeTicket(sellerId, ticketKey, resourceId, amount) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    v: "pt1",
    sellerId,
    resourceId,
    amount: String(amount),
    nonce: crypto.randomBytes(8).toString("hex"),
    iat: now,
    exp: now + 600
  };

  const payload = b64url(JSON.stringify(claims));
  const signature = crypto
    .createHmac("sha256", ticketKey)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

async function facilitatorPost(path, body) {
  const response = await fetch(`${FACILITATOR}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  const sellerId = process.env.QUBIC_ADDRESS;
  const ticketKey = process.env.QPAY_TICKET_KEY;

  if (!sellerId || !ticketKey) {
    return res.status(500).json({
      error: "Server configuration missing",
      required: ["QUBIC_ADDRESS", "QPAY_TICKET_KEY"]
    });
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const supportedResponse = await fetch(`${FACILITATOR}/supported`);
    if (!supportedResponse.ok) {
      return res.status(502).json({
        error: "Could not load facilitator configuration"
      });
    }

    const supported = await supportedResponse.json();
    const settlement = supported.settlement || {};
    const payTo = settlement.contractAddress;

    if (!payTo || settlement.name !== "contract") {
      return res.status(502).json({
        error: "Unsupported facilitator settlement configuration"
      });
    }

    const makeRequirements = (resourceId, amount) => ({
      scheme: "exact",
      network: "qubic:mainnet",
      amount: String(amount),
      asset: "QUBIC",
      payTo,
      maxTimeoutSeconds: 120,
      extra: {
        sellerId,
        resourceId,
        settlement: "contract"
      }
    });

    const openRequirements = makeRequirements("channel:open", DEPOSIT);
    const openTicket = makeTicket(
      sellerId,
      ticketKey,
      "channel:open",
      DEPOSIT
    );

    if (req.method === "GET") {
      return res.status(402).json({
        x402Version: 2,
        error: "Prepaid channel payment required",
        accepts: [makeRequirements(RESOURCE, PRICE)],
        channel: {
          deposit: DEPOSIT,
          price: PRICE,
          requirements: openRequirements,
          ticket: openTicket,
          openHeader: "X-CHANNEL-OPEN",
          voucherHeader: "X-CHANNEL-VOUCHER",
          voucherMessage:
            "Sign channel:<buyer-address>:<seller-address>:<cumulativeAmount> according to the Q+Pay prepaid channel protocol",
          balanceUrl: `${FACILITATOR}/channel`
        }
      });
    }

    const openHeader = req.headers["x-channel-open"];
    const voucherHeader = req.headers["x-channel-voucher"];

    if (!openHeader || !voucherHeader) {
      return res.status(402).json({
        error: "Both X-CHANNEL-OPEN and X-CHANNEL-VOUCHER are required"
      });
    }

    let paymentPayload;
    let voucher;

    try {
      paymentPayload = JSON.parse(
        Buffer.from(openHeader, "base64").toString("utf8")
      );
      voucher = JSON.parse(
        Buffer.from(voucherHeader, "base64").toString("utf8")
      );
    } catch {
      return res.status(400).json({ error: "Invalid channel header encoding" });
    }

    if (
      !voucher.channelId ||
      !/^[0-9]+$/.test(String(voucher.cumulativeAmount)) ||
      !/^[0-9a-f]{128}$/.test(String(voucher.signature))
    ) {
      return res.status(400).json({ error: "Invalid voucher fields" });
    }

    const openResult = await facilitatorPost("/channel/open", {
      paymentPayload,
      paymentRequirements: openRequirements
    });

    if (!openResult.data.success) {
      return res.status(openResult.status === 402 ? 402 : 502).json({
        error: "Channel deposit could not be opened",
        details: openResult.data
      });
    }

    const message = [
      "redeem",
      voucher.channelId,
      String(voucher.cumulativeAmount),
      PRICE
    ].join(":");

    const sellerAuth = crypto
      .createHmac("sha256", ticketKey)
      .update(message)
      .digest("hex");

    const redeemResult = await facilitatorPost("/channel/redeem", {
      channelId: voucher.channelId,
      sellerId,
      price: PRICE,
      cumulativeAmount: String(voucher.cumulativeAmount),
      signature: voucher.signature,
      sellerAuth
    });

    if (!redeemResult.data.success) {
      return res.status(redeemResult.status === 402 ? 402 : 502).json({
        error: "Channel voucher could not be redeemed",
        details: redeemResult.data
      });
    }

    res.setHeader(
      "X-CHANNEL-REMAINING",
      String(redeemResult.data.remaining ?? "")
    );

    return res.status(200).json({
      success: true,
      message: "Prepaid channel request accepted",
      channelId: voucher.channelId,
      price: PRICE,
      result: "Q+Pay prepaid channel"
    });
  } catch (error) {
    return res.status(502).json({
      error: "Prepaid channel request failed",
      details: error.message
    });
  }
};
