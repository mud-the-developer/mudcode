(function () {
  function copyWithFallback(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
  }

  function getLabels() {
    var isKorean = (document.documentElement.lang || "").toLowerCase().startsWith("ko");
    if (isKorean) {
      return {
        copy: "복사",
        copied: "복사됨",
        copyAria: "설치 명령어 복사",
      };
    }
    return {
      copy: "Copy",
      copied: "Copied",
      copyAria: "Copy install command",
    };
  }

  function setupInstallCommandCopyButtons() {
    var installSection = document.getElementById("install");
    if (!installSection) return;

    var commandBlocks = installSection.querySelectorAll("pre.command");
    if (!commandBlocks.length) return;

    var labels = getLabels();

    commandBlocks.forEach(function (block) {
      if (block.querySelector(".command-copy-btn")) return;

      var code = block.querySelector("code");
      if (!code) return;

      var button = document.createElement("button");
      button.type = "button";
      button.className = "command-copy-btn";
      button.textContent = labels.copy;
      button.setAttribute("aria-label", labels.copyAria);

      button.addEventListener("click", function () {
        var text = code.textContent || "";
        if (!text) return;

        var writePromise = navigator.clipboard && navigator.clipboard.writeText
          ? navigator.clipboard.writeText(text)
          : Promise.resolve().then(function () {
              copyWithFallback(text);
            });

        writePromise
          .then(function () {
            button.textContent = labels.copied;
            window.setTimeout(function () {
              button.textContent = labels.copy;
            }, 1400);
          })
          .catch(function () {
            copyWithFallback(text);
            button.textContent = labels.copied;
            window.setTimeout(function () {
              button.textContent = labels.copy;
            }, 1400);
          });
      });

      block.appendChild(button);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupInstallCommandCopyButtons);
    return;
  }

  setupInstallCommandCopyButtons();
})();
