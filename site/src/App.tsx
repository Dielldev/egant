import { Agents } from "./components/Agents";
import { Customize } from "./components/Customize";
import { Features } from "./components/Features";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Nav } from "./components/Nav";
import { Phone } from "./components/Phone";
import { Quickstart } from "./components/Quickstart";
import { Showcase } from "./components/Showcase";

export function App() {
  return (
    <>
      <div className="backdrop" aria-hidden>
        <span className="glow glow-a" />
        <span className="glow glow-b" />
      </div>
      <Nav />
      <main>
        <Hero />
        <Agents />
        <Features />
        <Showcase />
        <Customize />
        <Phone />
        <Quickstart />
      </main>
      <Footer />
    </>
  );
}
