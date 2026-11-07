import { useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "light" | "dark";

// index.html sets data-theme before first paint; this just reads it back.
const current = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);

  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("egant-theme", next);
    } catch {
      // Private mode: the choice just won't persist.
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      className="icon-btn"
      onClick={flip}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`${theme === "dark" ? "Light" : "Dark"} mode`}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
