/** @jsxImportSource @opentui/solid */
/** @jsxRuntime automatic */

import { InputRenderable, RGBA, TextAttributes, TextareaRenderable } from '@opentui/core';
import { render, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/solid';
import { For, Show, createMemo, createSignal, onCleanup, onMount } from 'solid-js';

type TuiInput = {
  onCommand: (command: string, append: (line: string) => void) => Promise<boolean | void>;
  onStopProject: (project: string) => Promise<void>;
  getProjects: () => Array<{
    project: string;
    session: string;
    window: string;
    ai: string;
    channel: string;
    open: boolean;
  }>;
};

const palette = {
  bg: '#0a0a0a',
  panel: '#141414',
  border: '#484848',
  text: '#eeeeee',
  muted: '#9a9a9a',
  primary: '#fab283',
  selectedBg: '#2b2b2b',
  selectedFg: '#ffffff',
};

const slashCommands = [
  { command: '/session_new', description: 'create new session' },
  { command: '/new', description: 'alias for /session_new' },
  { command: '/stop', description: 'select and stop a project' },
  { command: '/projects', description: 'list configured projects' },
  { command: '/help', description: 'show available commands' },
  { command: '/exit', description: 'close the TUI' },
  { command: '/quit', description: 'close the TUI' },
];

const paletteCommands = [
  { command: '/session_new', description: 'Create a new session' },
  { command: '/new', description: 'Alias for /session_new' },
  { command: '/stop', description: 'Select and stop a project' },
  { command: '/projects', description: 'List configured projects' },
  { command: '/help', description: 'Show help' },
  { command: '/exit', description: 'Exit TUI' },
  { command: '/quit', description: 'Exit TUI' },
];

function TuiApp(props: { input: TuiInput; close: () => void }) {
  const dims = useTerminalDimensions();
  const renderer = useRenderer();
  const [value, setValue] = createSignal('');
  const [selected, setSelected] = createSignal(0);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal('');
  const [paletteSelected, setPaletteSelected] = createSignal(0);
  const [stopOpen, setStopOpen] = createSignal(false);
  const [stopSelected, setStopSelected] = createSignal(0);
  const [projects, setProjects] = createSignal<Array<{
    project: string;
    session: string;
    window: string;
    ai: string;
    channel: string;
    open: boolean;
  }>>([]);
  let textarea: TextareaRenderable;
  let paletteInput: InputRenderable;

  const openProjects = createMemo(() => projects().filter((item) => item.open));
  const stoppableProjects = createMemo(() => {
    const names = new Set<string>();
    openProjects().forEach((item) => names.add(item.project));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  });
  const sessionTree = createMemo(() => {
    const groups = new Map<string, Array<{ window: string; ai: string; channel: string }>>();
    openProjects().forEach((item) => {
      const list = groups.get(item.session) || [];
      list.push({ window: item.window, ai: item.ai, channel: item.channel });
      groups.set(item.session, list);
    });
    return Array.from(groups.entries())
      .map(([session, items]) => ({
        session,
        items: items.sort((a, b) => a.window.localeCompare(b.window)),
      }))
      .sort((a, b) => a.session.localeCompare(b.session));
  });

  const query = createMemo(() => {
    const next = value();
    if (!next.startsWith('/')) return null;
    if (next.includes(' ')) return null;
    return next.slice(1).toLowerCase();
  });

  const matches = createMemo(() => {
    if (paletteOpen()) return [];
    const next = query();
    if (next === null) return [];
    if (next.length === 0) return slashCommands;
    return slashCommands.filter((item) => item.command.slice(1).startsWith(next));
  });

  const paletteMatches = createMemo(() => {
    const q = paletteQuery().trim().toLowerCase();
    if (!q) return paletteCommands;
    return paletteCommands.filter((item) => {
      return item.command.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
    });
  });

  const clampSelection = (offset: number) => {
    const items = matches();
    if (items.length === 0) return;
    const count = items.length;
    const next = (selected() + offset + count) % count;
    setSelected(next);
  };

  const applySelection = () => {
    const item = matches()[selected()];
    if (!item) return;
    const next = `${item.command} `;
    textarea.setText(next);
    setValue(next);
    textarea.gotoBufferEnd();
  };

  const openCommandPalette = () => {
    setPaletteOpen(true);
    setPaletteQuery('');
    setPaletteSelected(0);
    textarea?.blur();
    setTimeout(() => {
      if (!paletteInput || paletteInput.isDestroyed) return;
      paletteInput.focus();
    }, 1);
  };

  const closeCommandPalette = () => {
    setPaletteOpen(false);
    setPaletteQuery('');
    setPaletteSelected(0);
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
  };

  const clampPaletteSelection = (offset: number) => {
    const items = paletteMatches();
    if (items.length === 0) return;
    const next = (paletteSelected() + offset + items.length) % items.length;
    setPaletteSelected(next);
  };

  const executePaletteSelection = async () => {
    const item = paletteMatches()[paletteSelected()];
    if (!item) return;
    if (item.command === '/stop') {
      closeCommandPalette();
      setStopOpen(true);
      setStopSelected(0);
      return;
    }
    closeCommandPalette();
    const shouldClose = await props.input.onCommand(item.command, () => {});
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  const closeStopDialog = () => {
    setStopOpen(false);
    setStopSelected(0);
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return;
      textarea.focus();
    }, 1);
  };

  const clampStopSelection = (offset: number) => {
    const items = stoppableProjects();
    if (items.length === 0) return;
    const next = (stopSelected() + offset + items.length) % items.length;
    setStopSelected(next);
  };

  const executeStopSelection = async () => {
    const project = stoppableProjects()[stopSelected()];
    if (!project) return;
    closeStopDialog();
    await props.input.onStopProject(project);
  };

  const submit = async () => {
    const raw = textarea?.plainText ?? '';
    const command = raw.trim();
    textarea?.setText('');
    setValue('');
    if (!command) return;

    if (command === 'stop' || command === '/stop') {
      setStopOpen(true);
      setStopSelected(0);
      return;
    }

    const shouldClose = await props.input.onCommand(command, () => {});
    if (shouldClose) {
      renderer.destroy();
      props.close();
    }
  };

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === 'p') {
      evt.preventDefault();
      if (!paletteOpen()) {
        openCommandPalette();
      }
      return;
    }

    if (paletteOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeCommandPalette();
        return;
      }
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampPaletteSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
        evt.preventDefault();
        clampPaletteSelection(1);
        return;
      }
      if (evt.name === 'pageup') {
        evt.preventDefault();
        clampPaletteSelection(-10);
        return;
      }
      if (evt.name === 'pagedown') {
        evt.preventDefault();
        clampPaletteSelection(10);
        return;
      }
      if (evt.name === 'home') {
        evt.preventDefault();
        setPaletteSelected(0);
        return;
      }
      if (evt.name === 'end') {
        evt.preventDefault();
        setPaletteSelected(Math.max(0, paletteMatches().length - 1));
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executePaletteSelection();
        return;
      }
      if (evt.name === 'tab') {
        evt.preventDefault();
        return;
      }
    }

    if (stopOpen()) {
      if (evt.name === 'escape') {
        evt.preventDefault();
        closeStopDialog();
        return;
      }
      if (evt.name === 'up' || (evt.ctrl && evt.name === 'p')) {
        evt.preventDefault();
        clampStopSelection(-1);
        return;
      }
      if (evt.name === 'down' || (evt.ctrl && evt.name === 'n')) {
        evt.preventDefault();
        clampStopSelection(1);
        return;
      }
      if (evt.name === 'return') {
        evt.preventDefault();
        void executeStopSelection();
        return;
      }
    }

    if (evt.ctrl && evt.name === 'c') {
      evt.preventDefault();
      renderer.destroy();
      props.close();
    }
  });

  onMount(() => {
    const refresh = () => {
      setProjects(props.input.getProjects());
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    onCleanup(() => clearInterval(timer));
    setTimeout(() => textarea?.focus(), 1);
  });

  return (
    <box width={dims().width} height={dims().height} backgroundColor={palette.bg} flexDirection="column">
      <box flexGrow={1} backgroundColor={palette.bg} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
        <box
          width={Math.max(40, Math.min(90, Math.floor(dims().width * 0.7)))}
          border
          borderColor={palette.border}
          backgroundColor={palette.panel}
          flexDirection="column"
        >
          <box paddingLeft={1} paddingRight={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>Current sessions</text>
          </box>
          <Show when={sessionTree().length > 0} fallback={<box paddingLeft={1} paddingRight={1}><text fg={palette.muted}>No current sessions</text></box>}>
            <For each={sessionTree().slice(0, 6)}>
              {(session) => (
                <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1}>
                  <text fg={palette.text}>{`session: ${session.session}`}</text>
                  <For each={session.items}>
                    {(item, index) => (
                      <>
                        <text fg={palette.text}>{`${index() === session.items.length - 1 ? '`--' : '|--'} window: ${item.window}`}</text>
                        <text fg={palette.text}>{`${index() === session.items.length - 1 ? '    ' : '|   '}ai: ${item.ai}`}</text>
                        <text fg={palette.text}>{`${index() === session.items.length - 1 ? '    ' : '|   '}channel: ${item.channel}`}</text>
                      </>
                    )}
                  </For>
                </box>
              )}
            </For>
          </Show>
        </box>
      </box>

      <Show when={matches().length > 0}>
        <box backgroundColor={palette.bg} paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <box border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
            <For each={matches().slice(0, 6)}>
              {(item, index) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selected() === index() ? palette.selectedBg : palette.panel}
                >
                  <text fg={selected() === index() ? palette.selectedFg : palette.text}>{item.command}</text>
                  <text fg={palette.muted}>{`  ${item.description}`}</text>
                </box>
              )}
            </For>
          </box>
        </box>
      </Show>

      <Show when={paletteOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Commands</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <box paddingLeft={4} paddingRight={4} paddingTop={1}>
              <input
                ref={(r: InputRenderable) => {
                  paletteInput = r;
                }}
                placeholder="Search"
                cursorColor={palette.primary}
                focusedTextColor={palette.muted}
                focusedBackgroundColor={palette.bg}
                onInput={(next) => {
                  setPaletteQuery(next);
                  setPaletteSelected(0);
                }}
              />
            </box>
            <Show when={paletteMatches().length > 0} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>No commands</text></box>}>
              <For each={paletteMatches().slice(0, Math.max(8, Math.floor(dims().height / 2) - 6))}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={paletteSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={paletteSelected() === index() ? palette.selectedFg : palette.text}>{item.command}</text>
                    <text fg={palette.muted}>{`  ${item.description}`}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Select </text>
              <text fg={palette.muted}>enter</text>
            </box>
          </box>
        </box>
      </Show>

      <Show when={stopOpen()}>
        <box
          width={dims().width}
          height={dims().height}
          backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
          position="absolute"
          left={0}
          top={0}
          alignItems="center"
          paddingTop={Math.floor(dims().height / 4)}
        >
          <box
            width={Math.max(50, Math.min(70, dims().width - 2))}
            backgroundColor={palette.panel}
            flexDirection="column"
            paddingTop={1}
            paddingBottom={1}
          >
            <box paddingLeft={4} paddingRight={4} flexDirection="row" justifyContent="space-between">
              <text fg={palette.primary} attributes={TextAttributes.BOLD}>Stop project</text>
              <text fg={palette.muted}>esc</text>
            </box>
            <Show when={stoppableProjects().length > 0} fallback={<box paddingLeft={4} paddingRight={4} paddingTop={1}><text fg={palette.muted}>No running projects</text></box>}>
              <For each={stoppableProjects().slice(0, 10)}>
                {(item, index) => (
                  <box
                    paddingLeft={3}
                    paddingRight={1}
                    paddingTop={index() === 0 ? 1 : 0}
                    backgroundColor={stopSelected() === index() ? palette.selectedBg : palette.panel}
                  >
                    <text fg={stopSelected() === index() ? palette.selectedFg : palette.text}>{item}</text>
                  </box>
                )}
              </For>
            </Show>
            <box paddingLeft={4} paddingRight={2} paddingTop={1}>
              <text fg={palette.text}>Stop </text>
              <text fg={palette.muted}>enter</text>
            </box>
          </box>
        </box>
      </Show>

      <box backgroundColor={palette.bg} paddingLeft={2} paddingRight={2} paddingBottom={1}>
        <box border borderColor={palette.border} backgroundColor={palette.panel} flexDirection="column">
          <box paddingLeft={1} paddingRight={1}>
            <text fg={palette.primary} attributes={TextAttributes.BOLD}>{'agent-bridge> '}</text>
          </box>
          <box paddingLeft={1} paddingRight={1}>
            <textarea
              ref={(input: TextareaRenderable) => {
                textarea = input;
              }}
              minHeight={1}
              maxHeight={4}
              onSubmit={submit}
              keyBindings={[{ name: 'return', action: 'submit' }]}
              placeholder="Type a command"
              textColor={palette.text}
              focusedTextColor={palette.text}
              cursorColor={palette.primary}
              onContentChange={() => {
                const next = textarea.plainText;
                setValue(next);
                setSelected(0);
              }}
              onKeyDown={(event) => {
                if (paletteOpen() || stopOpen()) {
                  event.preventDefault();
                  return;
                }
                if (matches().length === 0) return;
                if (event.name === 'up') {
                  event.preventDefault();
                  clampSelection(-1);
                  return;
                }
                if (event.name === 'down') {
                  event.preventDefault();
                  clampSelection(1);
                  return;
                }
                if (event.name === 'tab') {
                  event.preventDefault();
                  applySelection();
                  return;
                }
                if (event.name === 'return' && query() !== null) {
                  event.preventDefault();
                  applySelection();
                }
              }}
            />
          </box>
        </box>
      </box>
    </box>
  );
}

export function runTui(input: TuiInput): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      resolve();
    };
    void render(() => <TuiApp input={input} close={close} />, {
      targetFps: 60,
      exitOnCtrlC: false,
      autoFocus: true,
    });
  });
}
