// Loaded as a classic script in <head> so the saved theme applies before first paint.
(() => {
  const KEY = "erudify-theme";
  const CHOICES = ["system", "light", "dark"];
  const root = document.documentElement;

  const read = () => {
    try {
      const saved = localStorage.getItem(KEY);
      return CHOICES.includes(saved) ? saved : "system";
    } catch {
      return "system";
    }
  };

  const apply = (choice) => {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
  };

  apply(read());

  document.addEventListener("DOMContentLoaded", () => {
    const group = document.querySelector("#theme");
    if (!group) return;
    const buttons = [...group.querySelectorAll("button[data-theme-choice]")];
    const sync = (choice) => {
      for (const button of buttons) {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.themeChoice === choice),
        );
      }
    };
    sync(read());
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-theme-choice]");
      if (!button) return;
      const choice = button.dataset.themeChoice;
      try {
        localStorage.setItem(KEY, choice);
      } catch {
        // Private mode or blocked storage: the choice lasts for this page only.
      }
      apply(choice);
      sync(choice);
    });
  });
})();
