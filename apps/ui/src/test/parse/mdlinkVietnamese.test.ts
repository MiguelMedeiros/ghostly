import { describe, expect, it } from "vitest";
import { labelMisleads, parseMessage } from "../../lib/parse";

// covers: chat.rich.mdlinks

const link = (text: string) => parseMessage(text).flatMap((b) => (b.type === "paragraph" ? b.segments : [])).find((s) => s.type === "atom");

const URL = "https://bachmai.gov.vn/x";

/** Common Vietnamese syllables, most of them in the low tone (a dot below their vowel: ạ ặ ậ ẹ ệ ị ọ ộ ợ ụ ự ỵ). */
const SYLLABLES = (
  "bệnh viện bạch mạng hội lịch sử việt nội thành phố hồ chí minh trường đại học bách khoa cộng hòa xã chủ nghĩa " +
  "báo tuổi trẻ dịch vụ công tiếng anh nguyễn trần lê phạm hoàng huỳnh phan vũ võ đặng bùi đỗ ngô dương lý thạch " +
  "trạng nghịch hoạch thuộc mượn nguyện quạ giặc ngoại cạnh địa chỉ điện thoại mặt trận lực lượng hạnh phúc tự do " +
  "độc lập mạnh khỏe đẹp chợ bận rộn chạy nhảy gặp bạn mọi người cục giao kỵ sĩ tịch thu lụa bịa dựa chịu khuỵu " +
  "ngoẹo nghiệp tập đoàn ngân hàng nhà nước quốc phụ nữ trợ giúp kiện tụng bộ y tế giáo dục đào tạo pháp kế đầu tư " +
  "tài chính hạ tầng thực phẩm mục nhật ký họp hậu cần lạnh nóng vội vàng chặt chẽ nặng nhẹ gạo nếp bánh mì phở bún " +
  "chả cá thịt vịt gà rượu bia đậu phụng lạc mực ốc tỏi ớt muối đường sạch ngọt mặn nhạt đắng cay chua lạng sơn " +
  "bạc liêu long đà nẵng quảng ngãi thanh hóa nghệ an phú côn đảo tây nguyên bình đồng nai cần thơ vịnh huỵch luật " +
  "nguyệt tuệ huệ thuỵ hoạ choạng xoẹt nguệch ngoạc việc vượt mỵ lụt ghẹ bịch lệnh kệch tượng dượng vậy đội đạt mộc " +
  "thuận ạ ơi hiện đặc biệt nhạc kịch phụ huynh sự kiện thị trấn huyện tỉnh trạm xá bệnh nhân cấp cứu chuyện"
).split(" ");

describe("a link's text in Vietnamese", () => {
  const labels = [
    "Bệnh viện Bạch Mai",
    "Mạng xã hội",
    "Lịch sử",
    "Việt Nam",
    "Hà Nội",
    "Thành phố Hồ Chí Minh",
    "Trường Đại học Bách khoa",
    "Cộng hòa xã hội chủ nghĩa Việt Nam",
    "Báo Tuổi Trẻ",
    "Dịch vụ công",
    "Học tiếng Anh",
    "BỆNH VIỆN BẠCH MAI",
    "Thạch Lam, Trạng Quỳnh",
    "Kế hoạch (2026)",
  ];

  it("is shown as written, whether its letters come whole or as a letter and its marks", () => {
    for (const label of [...labels, ...labels.map((l) => l.normalize("NFD"))]) {
      expect(labelMisleads(label, URL), label).toBe(false);
    }
    expect(link("[Bệnh viện Bạch Mai](https://bachmai.gov.vn/x)")).toMatchObject({ data: { showUrl: false } });
    expect(link("[**Mạng** xã hội](https://bachmai.gov.vn/x)")).toMatchObject({ data: { showUrl: false } });
  });

  it("is shown as written for any run of common words", () => {
    let seed = 8150;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
    const shown: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const words = Array.from({ length: 1 + (next() % 5) }, () => SYLLABLES[next() % SYLLABLES.length]);
      const label = words.map((w, j) => (j === 0 || next() % 4 === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
      if (labelMisleads(label, URL) || labelMisleads(label.normalize("NFD"), URL)) shown.push(label);
    }
    expect(shown).toEqual([]);
  });

  it("still names an address when it holds one", () => {
    expect(labelMisleads("Xem tại bachmai.gov.vn", URL)).toBe(false);
    expect(labelMisleads("Xem tại example.com", URL)).toBe(true);
  });
});
