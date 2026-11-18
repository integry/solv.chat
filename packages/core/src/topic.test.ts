import { describe, expect, it } from "vitest";
import {
  checkTopicName,
  cleanTopicName,
  OTHER_TOPIC_KEY,
  TOPIC_NAME_MAX_LENGTH,
  topicKey,
} from "./schemas/topic.js";

describe("topic names", () => {
  it("keeps short labels in any language", () => {
    expect(cleanTopicName("Opening hours")).toBe("Opening hours");
    expect(cleanTopicName("Öffnungszeiten")).toBe("Öffnungszeiten");
    expect(cleanTopicName("Returns & refunds")).toBe("Returns & refunds");
    expect(cleanTopicName("営業時間")).toBe("営業時間");
    expect(cleanTopicName("Plan 2026 pricing")).toBe("Plan 2026 pricing");
    expect(cleanTopicName("Horário de funcionamento")).toBe("Horário de funcionamento");
  });

  it("strips markup, control characters and surrounding punctuation", () => {
    expect(cleanTopicName("**Opening hours**")).toBe("Opening hours");
    expect(cleanTopicName("<b>Shipping</b> costs")).toBe("Shipping costs");
    expect(cleanTopicName("  Ship\u0000ping‮  costs. ")).toBe("Ship ping costs");
    expect(cleanTopicName('"Delivery times"')).toBe("Delivery times");
    expect(cleanTopicName("Ｂｉｌｌｉｎｇ")).toBe("Billing");
    expect(cleanTopicName("Zero​width")).toBe("Zero width");
  });

  it("refuses names that are too long, too wordy or empty", () => {
    expect(cleanTopicName("x".repeat(TOPIC_NAME_MAX_LENGTH))).not.toBeNull();
    expect(checkTopicName("x".repeat(TOPIC_NAME_MAX_LENGTH + 1))).toEqual({
      ok: false,
      problem: "too_long",
    });
    expect(checkTopicName("one two three four five")).toEqual({
      ok: false,
      problem: "too_many_words",
    });
    expect(checkTopicName("  ** ")).toEqual({ ok: false, problem: "empty" });
    expect(checkTopicName(42)).toEqual({ ok: false, problem: "empty" });
  });

  it("refuses anything that could capture personal data", () => {
    for (const unsafe of [
      "jane@example.com",
      "example.com",
      "www shop",
      "https example",
      "Call 555 123 4567",
      "Order 12345678",
      "Card 4111-1111-1111",
      "12 Baker Street",
      "Hauptstraße 5",
      "Flat 3 enquiry",
      "SW1A 1AA",
    ]) {
      expect(checkTopicName(unsafe).ok, unsafe).toBe(false);
    }
    expect(checkTopicName("jane@example.com")).toEqual({ ok: false, problem: "personal" });
    expect(checkTopicName("Order 123456")).toEqual({ ok: true, name: "Order 123456" });
  });

  it("refuses names that would start a spreadsheet formula", () => {
    expect(cleanTopicName("=HYPERLINK(1)")).toBeNull();
    expect(cleanTopicName("+cmd")).toBeNull();
    expect(cleanTopicName("@SUM")).toBeNull();
    expect(cleanTopicName("-2+3 topics")).toBeNull();
  });

  it("compares names case- and spacing-insensitively", () => {
    expect(topicKey("Opening  HOURS")).toBe(topicKey("opening hours"));
    expect(OTHER_TOPIC_KEY).toBe("other");
  });
});
