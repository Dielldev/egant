import { PHONE_SHOT } from "../content";
import { Reveal } from "./Reveal";

const STEPS = [
  ["Install Tailscale", "and sign in. egant itself only ever listens on 127.0.0.1."],
  ["Open Settings → Devices", "and click Connect device."],
  ["Scan the QR code.", "One-time code, gone after five minutes."],
] as const;

export function Phone() {
  return (
    <section className="section phone" id="phone">
      <Reveal className="phone-text">
        <p className="eyebrow">Your phone, too</p>
        <h2>
          Walk away. <span className="dim">Keep shipping.</span>
        </h2>
        <p className="lead">
          The desktop serves a small web client over your tailnet. Start a chat, switch models and
          answer prompts — the agents keep running on your computer.
        </p>
        <ol className="steps">
          {STEPS.map(([strong, rest], i) => (
            <li key={i}>
              <span className="step-n">0{i + 1}</span>
              <span>
                <b>{strong}</b> {rest}
              </span>
            </li>
          ))}
        </ol>
      </Reveal>
      <Reveal delay={150} className="phone-visual">
        <div className="phone-frame glass">
          <img src={PHONE_SHOT} alt="The egant phone client" loading="lazy" />
        </div>
      </Reveal>
    </section>
  );
}
