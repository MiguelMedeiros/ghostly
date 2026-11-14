import { describe, expect, it, vi } from "vitest";
import { inviteQrSegments } from "@ghostly/core";
import { InviteCard } from "../../components/InviteCard";
import { QRCodeDisplay } from "../../components/QRCode";
import { LinkQrDialog } from "../../components/chat/LinkQrDialog";
import { deviceLink, deviceLinkQr } from "../../lib/devices";
import { renderApp } from "../render";
// covers: invite.code, devices.enroll

/** What each QR was handed to encode: qrcode.react encodes again whenever that is another array, even an equal one. */
const handed = vi.hoisted(() => [] as unknown[]);
vi.mock("qrcode.react", async (importOriginal) => {
  const real = await importOriginal<typeof import("qrcode.react")>();
  const Real = real.QRCodeSVG;
  return { ...real, QRCodeSVG: (props: React.ComponentProps<typeof Real>) => { handed.push(props.value); return <Real {...props} />; } };
});

const code = "ghostly1zexampleexampleexampleexample";
/** How many times the QR was handed something to encode afresh. */
const encodes = () => new Set(handed).size;

describe("a QR whose words did not change is not encoded again", () => {
  it("the invite card, drawn again as the chat waits for its contact", () => {
    handed.length = 0;
    const { rerender } = renderApp(<InviteCard code={code} />);
    for (let i = 0; i < 5; i++) rerender(<InviteCard code={code} />);
    expect(handed.length).toBeGreaterThan(1);
    expect(encodes()).toBe(1);
    rerender(<InviteCard code={`${code}x`} />);
    expect(encodes()).toBe(2);
  });

  it("Add device's QR, drawn again each second by its time left", () => {
    handed.length = 0;
    const draw = () => <QRCodeDisplay value={deviceLink("abc", "https://ghostly.tools", "Me")} qr={deviceLinkQr("abc", "https://ghostly.tools", "Me")} />;
    const { rerender } = renderApp(draw());
    for (let i = 0; i < 5; i++) rerender(draw());
    expect(encodes()).toBe(1);
  });

  it("the link's QR dialog, drawn again with the chat behind it", () => {
    handed.length = 0;
    const draw = () => <LinkQrDialog title="Invite" url={code} qr={inviteQrSegments(code)} onClose={() => {}} />;
    const { rerender } = renderApp(draw());
    for (let i = 0; i < 5; i++) rerender(draw());
    expect(encodes()).toBe(1);
  });
});
