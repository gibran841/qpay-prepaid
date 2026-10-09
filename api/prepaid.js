
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

function decodeHeader(value) {
  if (typeof value !== "string") {
    throw new Error("Missing or invalid header");
  }
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
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

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sellerId = process.env.QUBIC_ADDRESS;
  const ticketKey = process.env.QPAY_TICKET_KEY;

  if (!sellerId || !ticketKey) {
    return res.status(500).json({
      error: "Server configuration missing",
      required: ["QUBIC_ADDRESS", "QPAY_TICKET_KEY"]
    });
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

    const requirements = (resourceId, amount) => ({
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

    const regularRequirements = requirements(RESOURCE, PRICE);
    const openRequirements = requirements("channel:open", DEPOSIT);

    if (req.method === "GET") {
      return res.status(402).json({
        x402Version: 2,
        error: "Payment required",
        accepts: [regularRequirements],
        paymentTicket: makeTicket(
          sellerId, ticketKey, RESOURCE, PRICE
        ),
        paymentTicketField: "paymentPayload.payload.ticket",
        channel: {
          deposit: DEPOSIT,
          price: PRICE,
          requirements: openRequirements,
          ticket: makeTicket(
            sellerId, ticketKey, "channel:open", DEPOSIT
          ),
          openHeader: "X-CHANNEL-OPEN",
          voucherHeader: "X-CHANNEL-VOUCHER",
          channelId: `<buyer-address>:${sellerId}`,
          voucherMessage: "channel:<channelId>:<cumulativeAmount>",
          balanceUrl: `${FACILITATOR}/channel`
        }
      });
    }

    const openHeader = req.headers["x-channel-open"];
    const voucherHeader = req.headers["x-channel-voucher"];
    const paymentHeader = req.headers["x-payment"];

    // Standard one-payment-per-request x402 flow.
    if (paymentHeader && !voucherHeader) {
      let paymentPayload;

      try {
        paymentPayload = decodeHeader(paymentHeader);
      } catch {
        return res.status(400).json({
          error: "Invalid X-PAYMENT encoding"
        });
      }

      const result = await facilitatorPost("/settle", {
        paymentPayload,
        paymentRequirements: regularRequirements
      });

      if (!result.data.success) {
        return res.status(result.status === 402 ? 402 : 502).json({
          error: "Payment could not be settled",
          details: result.data
        });
      }

      return res.status(200).json({
        success: true,
        message: "Payment accepted",
        payment: result.data
      });
    }

    if (!voucherHeader) {
      return res.status(402).json({
        error: "X-CHANNEL-VOUCHER is required"
      });
    }

    let voucher;

    try {
      voucher = decodeHeader(voucherHeader);
    } catch {
      return res.status(400).json({
        error: "Invalid channel voucher encoding"
      });
    }

    if (
      typeof voucher.channelId !== "string" ||
      !voucher.channelId.endsWith(`:${sellerId}`) ||
      !/^[0-9]+$/.test(String(voucher.cumulativeAmount)) ||
      !/^[0-9a-f]{128}$/.test(String(voucher.signature))
    ) {
      return res.status(400).json({
        error: "Invalid voucher fields"
      });
    }

    // Only open/top up the channel when a deposit payload is supplied.
    // Later requests can redeem a voucher without opening it again.
    if (openHeader) {
      let paymentPayload;

      try {
        paymentPayload = decodeHeader(openHeader);
      } catch {
        return res.status(400).json({
          error: "Invalid X-CHANNEL-OPEN encoding"
        });
      }

      const openResult = await facilitatorPost("/channel/open", {
        paymentPayload,
        paymentRequirements: openRequirements
      });

      if (!openResult.data.success) {
        return res.status(
          openResult.status === 402 ? 402 : 502
        ).json({
          error: "Channel deposit could not be opened",
          details: openResult.data
        });
      }
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
      return res.status(
        redeemResult.status === 402 ? 402 : 502
      ).json({
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
      remaining: redeemResult.data.remaining ?? null
    });
  } catch (error) {
    return res.status(502).json({
      error: "Prepaid channel request failed",
      details: error.message
    });
  }
};
