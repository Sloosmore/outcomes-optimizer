import { extractLinks, extractCode } from "../utils/extract.js";

describe("extractLinks", () => {
  it("extracts links from HTML href attributes", () => {
    const html = `
      <a href="https://example.com/verify?token=abc123">Click here</a>
      <a href="https://example.com/unsubscribe">Unsubscribe</a>
    `;
    const links = extractLinks(html, "");
    expect(links).toContain("https://example.com/verify?token=abc123");
    expect(links).toContain("https://example.com/unsubscribe");
  });

  it("extracts links from plain text", () => {
    const text = `
      Please verify your email: https://example.com/verify?token=abc123
      Or visit our website at https://example.com
    `;
    const links = extractLinks("", text);
    expect(links).toContain("https://example.com/verify?token=abc123");
    expect(links).toContain("https://example.com");
  });

  it("deduplicates links found in both HTML and text", () => {
    const html = '<a href="https://example.com/link">Link</a>';
    const text = "Visit https://example.com/link";
    const links = extractLinks(html, text);
    expect(links.filter((l) => l === "https://example.com/link")).toHaveLength(1);
  });

  it("ignores non-HTTP links", () => {
    const html = `
      <a href="mailto:test@example.com">Email</a>
      <a href="tel:+1234567890">Call</a>
      <a href="https://example.com">Valid</a>
    `;
    const links = extractLinks(html, "");
    expect(links).toHaveLength(1);
    expect(links[0]).toBe("https://example.com");
  });

  it("removes trailing punctuation from URLs", () => {
    const text = "Click here: https://example.com/page.";
    const links = extractLinks("", text);
    expect(links[0]).toBe("https://example.com/page");
  });

  it("returns empty array when no links found", () => {
    const links = extractLinks("No links here", "Just plain text");
    expect(links).toHaveLength(0);
  });
});

describe("extractCode", () => {
  it("extracts 6-digit verification code", () => {
    const text = "Your verification code is 123456";
    expect(extractCode(text)).toBe("123456");
  });

  it("extracts code with explicit label", () => {
    const text = "Your verification code: 987654";
    expect(extractCode(text)).toBe("987654");
  });

  it("extracts OTP", () => {
    const text = "Your OTP: 456789";
    expect(extractCode(text)).toBe("456789");
  });

  it("extracts code with 'your code is' format", () => {
    const text = "Your code is 112233";
    expect(extractCode(text)).toBe("112233");
  });

  it("extracts 4-digit code", () => {
    const text = "Enter PIN: 4567";
    expect(extractCode(text)).toBe("4567");
  });

  it("extracts 8-digit code", () => {
    const text = "Your passcode: 12345678";
    expect(extractCode(text)).toBe("12345678");
  });

  it("uses custom pattern when provided", () => {
    const text = "Reference: ABC-12345";
    expect(extractCode(text, "ABC-(\\d+)")).toBe("12345");
  });

  it("returns null when no code found", () => {
    const text = "No code in this email";
    expect(extractCode(text)).toBeNull();
  });

  it("prefers labeled codes over bare numbers", () => {
    // This text has both a labeled code and bare numbers
    const text = "Order #999 - Your verification code: 123456 - Total: $50";
    expect(extractCode(text)).toBe("123456");
  });
});
