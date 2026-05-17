import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test } from '@playwright/test';

const basePath = normalizeBasePath(process.env.BASE_PATH || '');
const appPath = (path = '/') => `${basePath}${path}`;

test('keeps page anchored with composer pinned to the viewport bottom', async ({ page }) => {
  await page.goto(appPath());
  await expect(page.getByText(/MCP apps|LLM-only chat/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export chat' })).toBeVisible();
  await expect(page.getByText('Ask for a dashboard, SQL chart, Elastic/Kibana workflow, or Trino/Starburst analytics preview.')).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.composer')!.getBoundingClientRect();
    const messages = document.querySelector('.messages')!.getBoundingClientRect();
    return {
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      composerBottom: Math.round(window.innerHeight - composer.bottom),
      messagesAboveComposer: messages.bottom <= composer.top + 1
    };
  });

  expect(layout.pageScrolls).toBe(false);
  expect(Math.abs(layout.composerBottom)).toBeLessThanOrEqual(1);
  expect(layout.messagesAboveComposer).toBe(true);
});

test('remembers the left navigation collapsed state', async ({ page }) => {
  await page.goto(appPath());
  await page.getByTitle('Collapse navigation').click();
  await expect(page.locator('.shell.navCollapsed')).toBeVisible();

  await page.reload();
  await expect(page.locator('.shell.navCollapsed')).toBeVisible();

  await page.getByTitle('Expand navigation').click();
  await expect(page.locator('.shell.navCollapsed')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.shell.navCollapsed')).toHaveCount(0);
});

test('supports message copy, edit, and retry controls', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Test assistant response',
        toolCalls: [],
        usage: {
          promptTokens: 12,
          completionTokens: 7,
          totalTokens: 19,
          model: 'fixture-model',
          source: 'llm'
        }
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('hello dashboard');
  await page.getByTitle('Send').click();

  await expect(page.locator('.messages').getByText('hello dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Test assistant response')).toBeVisible();
  await expect(page.getByLabel('Token usage').filter({ hasText: '19 tokens' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export chat' })).toBeEnabled();
  await page.getByRole('button', { name: 'Export chat' }).click();
  await expect(page.getByRole('menuitem', { name: 'GitHub Markdown ZIP' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'DOCX' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'PDF' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Copy' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...')).toHaveValue('hello dashboard');
  await expect(page.getByText('Test assistant response')).toHaveCount(0);
});

test('shows layman RCA and fix guidance for failed requests', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'The request took too long and was stopped.',
        technicalError: 'MCP error -32001: Request timed out',
        explanation: {
          headline: 'The request took too long and was stopped.',
          whatHappened: 'Rubberband waited for the selected MCP tool, but it did not finish before the timeout.',
          likelyCauses: ['The tool tried to inspect too much metadata at once.'],
          suggestedFixes: ['Try a narrower request with a specific catalog or schema.'],
          technicalSummary: 'MCP error -32001: Request timed out',
          generatedBy: 'llm'
        }
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show all trino catalogs');
  await page.getByTitle('Send').click();

  await expect(page.getByLabel('Failure explanation')).toBeVisible();
  await expect(page.getByText('The request took too long and was stopped.')).toBeVisible();
  await expect(page.getByText('Likely causes')).toBeVisible();
  await expect(page.getByText('What to try')).toBeVisible();
  await expect(page.getByText(/specific catalog or schema/)).toBeVisible();
});

test('dismisses failed request banners and clears them on new chat', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'The request took too long and was stopped.',
        technicalError: 'MCP error -32001: Request timed out',
        explanation: {
          headline: 'The request took too long and was stopped.',
          whatHappened: 'Rubberband waited for the selected MCP tool, but it did not finish before the timeout.',
          likelyCauses: ['The tool tried to inspect too much metadata at once.'],
          suggestedFixes: ['Try a narrower request with a specific catalog or schema.'],
          technicalSummary: 'MCP error -32001: Request timed out',
          generatedBy: 'local'
        }
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show all trino catalogs');
  await page.getByTitle('Send').click();
  await expect(page.getByLabel('Failure explanation')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.getByLabel('Failure explanation')).toHaveCount(0);

  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show all trino catalogs again');
  await page.getByTitle('Send').click();
  await expect(page.getByLabel('Failure explanation')).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByLabel('Failure explanation')).toHaveCount(0);
});

test('renders clickable suggested follow-up questions', async ({ page }) => {
  let latestChatBody: { messages?: Array<{ content: string }> } | undefined;
  let count = 0;
  await page.route('**/api/chat', async route => {
    count += 1;
    latestChatBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: count === 1 ? 'Catalog map ready.' : 'Follow-up answer ready.',
        toolCalls: [],
        followUps: count === 1 ? ['Which catalog relationships are strongest?', 'Show the most useful tables in each catalog.'] : []
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('visualize trino catalogs');
  await page.getByTitle('Send').click();

  await expect(page.getByLabel('Suggested follow-up questions')).toBeVisible();
  await page.getByRole('button', { name: 'Which catalog relationships are strongest?' }).click();

  await expect(page.getByText('Follow-up answer ready.')).toBeVisible();
  expect(latestChatBody?.messages?.at(-1)?.content).toBe('Which catalog relationships are strongest?');
});

test('persists the active chat and restores conversations from local history', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    const body = route.request().postDataJSON() as { messages?: Array<{ content: string }> };
    const prompt = body.messages?.at(-1)?.content || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: `Response for ${prompt}`,
        toolCalls: []
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('persistent dashboard');
  await page.getByTitle('Send').click();
  await expect(page.getByText('Response for persistent dashboard')).toBeVisible();

  await page.reload();
  await expect(page.locator('.messages').getByText('persistent dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Response for persistent dashboard')).toBeVisible();

  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.locator('.messages').getByText('persistent dashboard', { exact: true })).toHaveCount(0);

  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('second dashboard');
  await page.getByTitle('Send').click();
  await expect(page.getByText('Response for second dashboard')).toBeVisible();

  await page.getByRole('button', { name: /History/ }).click();
  await page.locator('.historyOpen').filter({ hasText: 'persistent dashboard' }).click();
  await expect(page.getByText('Response for persistent dashboard')).toBeVisible();
  await expect(page.getByText('Response for second dashboard')).toHaveCount(0);

  await page.getByRole('button', { name: /clear all history/i }).click();
  await expect(page.getByText('Response for persistent dashboard')).toHaveCount(0);
  await expect(page.locator('.historyOpen')).toHaveCount(1);
});

test('prunes old chat history when browser storage quota is hit', async ({ page }) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    const oldConversation = {
      id: 'old-chat',
      title: 'older dashboard',
      createdAt: '2026-05-10T00:00:00.000Z',
      updatedAt: '2026-05-10T00:00:00.000Z',
      messages: [
        { id: 'old-user', role: 'user', content: 'older dashboard' },
        { id: 'old-assistant', role: 'assistant', content: `old response ${'x'.repeat(900)}` }
      ]
    };
    originalSetItem.call(window.localStorage, 'rubberband.chatHistory.v1', JSON.stringify([oldConversation]));
    originalSetItem.call(window.localStorage, 'rubberband.activeConversationId.v1', 'old-chat');
    Storage.prototype.setItem = function patchedSetItem(key: string, value: string) {
      if (key === 'rubberband.chatHistory.v1' && value.length > 1200) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
  });

  await page.goto(appPath());
  await page.getByRole('button', { name: 'New chat' }).click();

  const storedHistory = await page.evaluate(() => window.localStorage.getItem('rubberband.chatHistory.v1') || '');
  expect(storedHistory).not.toContain('older dashboard');
});

test('collapses and expands message bubbles with one-line previews', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Long assistant response line one. This continues with enough detail to overflow the collapsed preview.\n\nSecond paragraph that should be hidden while collapsed.',
        toolCalls: [
          {
            id: 'call-1',
            appId: 'dashbuilder',
            toolName: 'view_dashboard',
            toolInput: {},
            toolResult: { content: [] },
            resourceUri: 'ui://example-mcp-dashbuilder/dashboard-preview.html',
            title: 'Dashboard preview'
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show long response');
  await page.getByTitle('Send').click();

  const assistantMessage = page.locator('.message.assistant').last();
  await expect(assistantMessage.locator('.appFrame')).toBeVisible();
  await assistantMessage.getByRole('button', { name: 'Collapse message' }).click();
  await expect(assistantMessage.locator('.bubble')).toHaveClass(/collapsed/);
  await expect(assistantMessage.locator('.appFrame')).toHaveCount(0);

  const collapsedHeight = await assistantMessage.locator('.bubbleBody').evaluate(element => element.getBoundingClientRect().height);
  expect(collapsedHeight).toBeLessThan(30);

  await assistantMessage.getByRole('button', { name: 'Expand message' }).click();
  await expect(assistantMessage.locator('.bubble')).not.toHaveClass(/collapsed/);
  await expect(assistantMessage.locator('.appFrame')).toBeVisible();
});

test('renders assistant markdown and exposes chat text size control', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content:
          '**Bold response**\n\n- first item\n- second item\n\n| What do you want to see? | Example |\n| --- | --- |\n| Business metrics | Revenue and orders |\n| Custom / ES\\|QL | Query-driven charts |',
        toolCalls: []
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('format this');
  await page.getByTitle('Send').click();

  await expect(page.locator('.markdown strong').filter({ hasText: 'Bold response' })).toBeVisible();
  await expect(page.locator('.markdown li').filter({ hasText: 'first item' })).toBeVisible();
  await expect(page.locator('.markdown table')).toBeVisible();
  await expect(page.locator('.markdown td').filter({ hasText: 'Business metrics' })).toBeVisible();
  await expect(page.locator('.markdown td').filter({ hasText: 'Custom / ES|QL' })).toBeVisible();

  await page.getByTitle('Settings').click();
  await page.getByRole('button', { name: 'UI', exact: true }).click();
  await expect(page.getByLabel('Chat text size')).toBeVisible();
});

test('expands MCP app previews for review', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Preview ready',
        toolCalls: [
          {
            id: 'call-1',
            appId: 'dashbuilder',
            toolName: 'create_chart',
            toolInput: {},
            toolResult: { content: [] },
            resourceUri: 'ui://example-mcp-dashbuilder/chart-preview.html',
            title: 'Elastic Dashbuilder: create_chart'
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show preview');
  await page.getByTitle('Send').click();

  const frame = page.locator('.appFrame').first();
  await expect(frame.getByText('Elastic Dashbuilder: create_chart')).toBeVisible();
  await frame.getByRole('button', { name: 'Expand review' }).click();
  await expect(frame).toHaveClass(/expanded/);
  await expect(frame.locator('.renderer')).toHaveClass(/fitToFrame/);
  await frame.getByRole('button', { name: 'Show preview tools' }).click();
  await frame.getByRole('button', { name: 'Use native preview scale' }).click();
  await expect(frame.locator('.renderer')).not.toHaveClass(/fitToFrame/);
  await frame.getByRole('button', { name: 'Fit preview to review area' }).click();
  await expect(frame.locator('.renderer')).toHaveClass(/fitToFrame/);
  await frame.getByRole('button', { name: 'Enable preview pan and zoom' }).click();
  await frame.getByRole('button', { name: 'Zoom preview in' }).click();
  await expect(frame.locator('.previewStage')).toHaveAttribute('style', /scale\(1\.18/);
  const overlayBox = await frame.locator('.previewPanOverlay').boundingBox();
  expect(overlayBox).not.toBeNull();
  if (overlayBox) {
    await page.mouse.move(overlayBox.x + 80, overlayBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(overlayBox.x + 150, overlayBox.y + 125);
    await page.mouse.up();
  }
  await expect(frame.locator('.previewStage')).toHaveAttribute('style', /translate\((?!0px, 0px)/);
  await frame.getByRole('button', { name: 'Reset preview pan and zoom' }).click();
  await expect(frame.locator('.previewStage')).toHaveAttribute('style', /translate\(0px, 0px\) scale\(1\)/);
  await page.keyboard.press('Escape');
  await expect(frame).not.toHaveClass(/expanded/);
});

test('keeps polling MCP app tool calls from replacing the active preview', async ({ page }) => {
  let resourceReadCount = 0;
  let pollCallCount = 0;
  const pollingAppHtml = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Alert Triage</h1>
      <p id="status">Loading alerts...</p>
    </main>
    <script>
      const pending = new Map();
      let nextId = 1;

      window.addEventListener('message', event => {
        const message = event.data || {};
        if (message.jsonrpc !== '2.0' || !Object.prototype.hasOwnProperty.call(message, 'id')) return;
        const callback = pending.get(message.id);
        if (!callback) return;
        pending.delete(message.id);
        callback(message);
      });

      function request(method, params) {
        const id = nextId++;
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
        return new Promise((resolve, reject) => {
          pending.set(id, message => {
            if (message.error) {
              reject(new Error(message.error.message || 'JSON-RPC request failed'));
              return;
            }
            resolve(message.result);
          });
        });
      }

      function notify(method, params) {
        window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
      }

      (async () => {
        await request('ui/initialize', {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'Polling test app', version: '1.0.0' },
          appCapabilities: { tools: {} }
        });
        notify('ui/notifications/initialized', {});

        for (let index = 0; index < 3; index += 1) {
          await request('tools/call', { name: 'poll-alerts', arguments: { index } });
          document.getElementById('status').textContent = 'Alerts loaded ' + (index + 1);
        }
      })().catch(error => {
        document.getElementById('status').textContent = error.message;
      });
    </script>
  </body>
</html>`;

  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Alert triage preview ready',
        toolCalls: [
          {
            id: 'security-preview-1',
            appId: 'security',
            toolName: 'triage-alerts',
            toolInput: {},
            toolResult: { content: [] },
            resourceUri: 'ui://triage-alerts/mcp-app.html',
            title: 'Security: triage-alerts'
          }
        ]
      })
    });
  });

  await page.route('**/api/apps/security/resources/read', async route => {
    resourceReadCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        contents: [
          {
            uri: 'ui://triage-alerts/mcp-app.html',
            mimeType: 'text/html;profile=mcp-app',
            text: pollingAppHtml
          }
        ]
      })
    });
  });

  await page.route('**/api/apps/security/tools/call?*', async route => {
    pollCallCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: [{ type: 'text', text: JSON.stringify({ alerts: [{ id: pollCallCount, severity: 'high' }] }) }],
        structuredContent: { alerts: [{ id: pollCallCount, severity: 'high' }] }
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('triage alerts');
  await page.getByTitle('Send').click();

  const frame = page.locator('.appFrame').first();
  await expect(frame.getByText('Security: triage-alerts')).toBeVisible();
  await expect.poll(() => pollCallCount).toBeGreaterThanOrEqual(3);
  await expect(frame.getByText('Security: triage-alerts')).toBeVisible();
  await expect(frame.getByText('security: poll-alerts')).toHaveCount(0);
  expect(resourceReadCount).toBe(1);
});

test('renders embedded MCP app HTML without resource refetches', async ({ page }) => {
  let resourceReadCount = 0;
  const embeddedHtml = `<!doctype html>
<html>
  <body>
    <main>
      <h1>Embedded MCP UI</h1>
      <p>Rendered from inline tool result HTML.</p>
    </main>
    <script>
      let nextId = 1;
      function request(method, params) {
        const id = nextId++;
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      }
      request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'Embedded test app', version: '1.0.0' },
        appCapabilities: {}
      });
      window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
    </script>
  </body>
</html>`;

  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Embedded preview ready',
        toolCalls: [
          {
            id: 'embedded-preview-1',
            appId: 'embedded',
            toolName: 'show_preview',
            toolInput: {},
            toolResult: { content: [] },
            html: embeddedHtml,
            title: 'Embedded preview'
          }
        ]
      })
    });
  });

  await page.route('**/api/apps/embedded/resources/read', async route => {
    resourceReadCount += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected resource read' }) });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show embedded preview');
  await page.getByTitle('Send').click();

  const frame = page.locator('.appFrame').first();
  await expect(frame.getByText('Embedded preview')).toBeVisible();
  await expect(frame.frameLocator('iframe').getByText('Embedded MCP UI')).toBeVisible();
  expect(resourceReadCount).toBe(0);
});

test('exports chat with visualization assets', async ({ page }) => {
  const previewImage = `data:image/png;base64,${await fs.readFile('public/rubberband-mark-32.png', 'base64')}`;

  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content:
          '### 🚨 Alert Triage\n> "Triage my critical and high severity alerts from the last 24 hours."\n\n| Catalog | Description |\n|---------|-------------|\n| **tpch** | TPC-H benchmark data — customer, orders, lineitem |\n| **system** | Trino system metadata |\n\n- Keep this clean',
        toolCalls: [
          {
            id: 'export-call-1',
            appId: 'dashbuilder',
            toolName: 'create_chart',
            toolInput: { query: 'from logs' },
            toolResult: { previewImage },
            resourceUri: 'ui://example-mcp-dashbuilder/chart-preview.html',
            title: 'Exported preview'
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('export this preview');
  await page.getByTitle('Send').click();
  await expect(page.getByText('Alert Triage')).toBeVisible();

  const markdownDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chat' }).click();
  await page.getByRole('menuitem', { name: 'GitHub Markdown ZIP' }).click();
  const markdownDownload = await markdownDownloadPromise;
  const markdownPath = await markdownDownload.path();
  expect(markdownDownload.suggestedFilename()).toMatch(/-\d{8}-\d{6}-markdown\.zip$/);
  expect(markdownPath).toBeTruthy();

  const zip = await JSZip.loadAsync(await fs.readFile(markdownPath!));
  const markdownFile = zip.file('chat.md');
  expect(markdownFile).toBeTruthy();
  const markdown = await markdownFile!.async('string');
  const assetNames = Object.keys(zip.files).filter(name => name.startsWith('assets/') && !zip.files[name].dir);
  expect(markdown).toContain('| Catalog | Description |');
  expect(markdown).toContain('![Exported preview');
  expect(assetNames.length).toBeGreaterThan(0);

  const docxDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chat' }).click();
  await page.getByRole('menuitem', { name: 'DOCX' }).click();
  const docxDownload = await docxDownloadPromise;
  const docxPath = await docxDownload.path();
  expect(docxDownload.suggestedFilename()).toMatch(/-\d{8}-\d{6}\.docx$/);
  expect(docxPath).toBeTruthy();
  const docxZip = await JSZip.loadAsync(await fs.readFile(docxPath!));
  const documentXml = await docxZip.file('word/document.xml')!.async('string');
  expect(documentXml).toContain('<w:tbl');
  expect(documentXml).toContain('Catalog');
  expect(documentXml).toContain('tpch');
  expect(documentXml).not.toContain('| Catalog |');
  expect(documentXml).not.toContain('**tpch**');
  expect(documentXml).not.toContain('🚨');

  const pdfDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export chat' }).click();
  await page.getByRole('menuitem', { name: 'PDF' }).click();
  expect((await pdfDownloadPromise).suggestedFilename()).toMatch(/-\d{8}-\d{6}\.pdf$/);
});

test('edits final MCP preview and starts canned visualization revisions', async ({ page }) => {
  let latestChatBody: { messages?: Array<{ role: string; content: string }> } | undefined;

  await page.route('**/api/chat', async route => {
    latestChatBody = route.request().postDataJSON();
    const lastPrompt = latestChatBody?.messages?.at(-1)?.content || '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: lastPrompt.includes('Analyze and summarize')
          ? 'Summary ready'
          : lastPrompt.includes('graph visualization')
            ? 'Graph preview ready'
            : lastPrompt.includes('bar chart')
              ? 'Bar chart preview ready'
            : 'Preview ready',
        toolCalls: [
          {
            id: 'call-1',
            appId: 'dashbuilder',
            toolName: 'create_chart',
            toolInput: { query: 'from logs' },
            toolResult: { content: [] },
            resourceUri: 'ui://example-mcp-dashbuilder/chart-preview.html',
            title: 'Final preview'
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show final preview');
  await page.getByTitle('Send').click();
  await expect(page.locator('.appFrame')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Move preview up' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Move preview down' })).toHaveCount(0);

  await page.locator('.appFrame').first().getByRole('button', { name: 'Rename preview' }).click();
  await page.locator('.appFrame').first().locator('.appFrameTitle input').fill('Renamed preview');
  await page.keyboard.press('Enter');
  await expect(page.locator('.appFrame').first()).toContainText('Renamed preview');

  await expect(page.locator('.appFrame').first().getByLabel('Visualization helpers')).toHaveCount(0);
  await page.locator('.appFrame').first().getByRole('button', { name: 'Show preview tools' }).click();
  await expect(page.locator('.appFrame').first().getByLabel('Visualization helpers')).toBeVisible();

  await page.locator('.appFrame').first().getByRole('button', { name: 'Use compact preview height' }).click();
  await expect(page.locator('.appFrame').first().locator('.renderer')).toHaveCSS('height', '480px');

  await page.locator('.appFrame').first().getByRole('button', { name: 'Regenerate as a bar chart' }).click();
  await expect(page.getByText('Bar chart preview ready')).toBeVisible();
  await expect(page.getByText('Regenerate "Renamed preview" as a bar chart.')).toHaveCount(0);
  expect(latestChatBody?.messages?.at(-1)?.content).toContain('as a bar chart');

  await page.locator('.appFrame').first().getByRole('button', { name: 'Regenerate as a graph visualization' }).click();
  await expect(page.getByText('Graph preview ready')).toBeVisible();
  await expect(page.getByText('Regenerate "Renamed preview" as a graph visualization.')).toHaveCount(0);
  expect(latestChatBody?.messages?.at(-1)?.content).toContain('as a graph visualization');

  await page.locator('.appFrame').first().getByRole('button', { name: 'Summarize visualization' }).click();
  await expect(page.getByText('Summary ready')).toBeVisible();
  await expect(page.getByText('Analyze and summarize the visualization "Renamed preview".')).toHaveCount(0);
  expect(latestChatBody?.messages?.at(-1)?.content).toContain('main takeaway');
});

test('renders host-native Trino catalog relationship maps', async ({ page }) => {
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Built a bounded Trino catalog relationship map.',
        toolCalls: [
          {
            id: 'catalog-map-1',
            appId: 'rubberband',
            toolName: 'trino_catalog_map',
            toolInput: { request: 'visualize catalogs' },
            title: 'Trino catalog relationship map',
            toolResult: {
              kind: 'trinoCatalogMap',
              map: {
                catalogs: [
                  { id: 'iceberg', tableCount: 12, schemaCount: 2, domains: ['commerce'], sampleTables: ['sales.orders'] },
                  { id: 'hive', tableCount: 8, schemaCount: 1, domains: ['commerce'], sampleTables: ['sales.customers'] }
                ],
                links: [{ source: 'iceberg', target: 'hive', strength: 6, reasons: ['domain commerce', 'schema sales', 'column customer_id'] }],
                skipped: { catalogs: 0, uninspectedTables: 0, inaccessibleCatalogs: [] }
              }
            }
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('visualize trino catalogs');
  await page.getByTitle('Send').click();

  const frame = page.locator('.appFrame').first();
  await expect(frame.getByText('Trino catalog relationship map')).toBeVisible();
  await expect(frame.getByLabel('Trino catalog relationship map')).toBeVisible();
  const catalogSection = frame.locator('.catalogMapDetails section').first();
  await expect(catalogSection.locator('article').filter({ hasText: /^iceberg/ })).toBeVisible();
  await expect(catalogSection.locator('article').filter({ hasText: /^hive/ })).toBeVisible();
  await expect(frame.getByText('domain commerce')).toBeVisible();

  const firstNode = frame.locator('.catalogNode').first();
  const beforeDrag = await firstNode.getAttribute('transform');
  await firstNode.dragTo(frame.locator('.catalogMapCanvas'), {
    targetPosition: { x: 620, y: 180 },
    force: true
  });
  await expect(firstNode).not.toHaveAttribute('transform', beforeDrag || '');

  const graphGroup = frame.locator('.catalogMapCanvas svg > g').first();
  await frame.getByRole('button', { name: 'Zoom in' }).click();
  await expect(graphGroup).toHaveAttribute('transform', /scale\((?!1\))/);
  await frame.getByRole('button', { name: 'Reset' }).click();
  await expect(graphGroup).toHaveAttribute('transform', 'translate(0 0) scale(1)');
});

test('shows canned action progress and cancels an active generation', async ({ page }) => {
  let chatCount = 0;
  await page.route('**/api/chat', async route => {
    chatCount += 1;
    if (chatCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          content: 'Preview ready',
          toolCalls: [
            {
              id: 'call-1',
              appId: 'dashbuilder',
              toolName: 'create_chart',
              toolInput: { query: 'from logs' },
              toolResult: { content: [] },
              resourceUri: 'ui://example-mcp-dashbuilder/chart-preview.html',
              title: 'Final preview'
            }
          ]
        })
      });
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: 'Canceled response should not render', toolCalls: [] })
    }).catch(() => undefined);
  });

  await page.goto(appPath());
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('show final preview');
  await page.getByTitle('Send').click();
  await expect(page.locator('.appFrame')).toHaveCount(1);

  await page.locator('.appFrame').first().getByRole('button', { name: 'Show preview tools' }).click();
  await page.locator('.appFrame').first().getByRole('button', { name: 'Summarize visualization' }).click();
  await expect(page.getByText('Summarizing visualization')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel request' })).toBeVisible();

  await page.getByRole('button', { name: 'Cancel request' }).click();
  await expect(page.getByText('Summarizing visualization')).toHaveCount(0);
  await expect(page.getByText('Analyze and summarize the visualization')).toHaveCount(0);
  await expect(page.getByText('Canceled response should not render')).toHaveCount(0);
});

test('opens settings and disables env-backed fields', async ({ page }) => {
  let testBody: { target?: string; values?: Record<string, string> } | undefined;
  let profilerRefreshCalled = false;
  const analyticsProfile = {
    enabled: true,
    scheduleMs: 86400000,
    staleAfterMs: 86400000,
    running: false,
    elastic: {
      target: 'elastic',
      status: 'ready',
      runCount: 2,
      lastCompletedAt: '2026-05-10T20:45:00.000Z',
      lastSuccessfulAt: '2026-05-10T20:45:00.000Z',
      nextRunAt: '2026-05-10T21:00:00.000Z',
      profile: {
        generatedAt: '2026-05-10T20:45:00.000Z',
        totalDiscoveredIndices: 12,
        totalDiscoveredDataStreams: 3,
        analyzedIndices: [{ name: 'logs-prod' }, { name: 'metrics-prod' }],
        suggestions: [{ question: 'Show alert trends' }],
        skipped: { systemIndices: 1, emptyIndices: 0 }
      }
    },
    trino: {
      target: 'trino',
      status: 'stale',
      runCount: 1,
      lastCompletedAt: '2026-05-10T19:30:00.000Z',
      lastSuccessfulAt: '2026-05-10T19:30:00.000Z',
      nextRunAt: '2026-05-10T21:00:00.000Z',
      profile: {
        generatedAt: '2026-05-10T19:30:00.000Z',
        connectionLabel: 'trino.fixture:8080',
        catalogs: ['tpch', 'iceberg'],
        analyzedTables: [{ name: 'orders' }, { name: 'lineitem' }, { name: 'customers' }],
        suggestions: [{ question: 'Map catalog relationships' }],
        skipped: { catalogs: 2, inaccessibleCatalogs: ['legacy: denied'] },
        cache: { hit: true, ttlMs: 86400000 }
      }
    }
  };
  await page.route('**/api/analytics-profile', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analyticsProfile) });
  });
  await page.route('**/api/analytics-profile/refresh', async route => {
    profilerRefreshCalled = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analyticsProfile) });
  });
  await page.route('**/api/settings/test', async route => {
    testBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        target: testBody?.target,
        label: 'LLM',
        ok: true,
        message: 'LLM responded from fixture.',
        durationMs: 12
      })
    });
  });

  await page.goto(appPath());
  await page.getByTitle('Settings').click();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'About', exact: true })).toBeVisible();
  await expect(page.getByText('Version')).toHaveCount(0);
  await expect(page.getByLabel('Profiler summary')).toHaveCount(0);

  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.getByText('Version')).toBeVisible();
  await expect(page.getByText('0.1.0')).toBeVisible();
  await expect(page.getByLabel('LLM API key')).toHaveCount(0);
  await expect(page.getByLabel('Domain knowledge', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Analytics Profiler', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Analytics Profiler', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run profiler now' })).toBeVisible();
  await expect(page.getByLabel('Profiler summary').getByText('Enabled')).toBeVisible();
  await expect(page.getByLabel('Profiler summary').getByText('1 day').first()).toBeVisible();
  await expect(page.getByLabel('Elasticsearch profiler status').getByText('Ready')).toBeVisible();
  await expect(page.getByLabel('Trino / Starburst profiler status').getByText('Stale')).toBeVisible();
  await expect(page.getByLabel('Analytics profiler schedule ms')).toHaveValue('86400000');
  await expect(page.getByLabel('Analytics profiler targets')).toHaveValue('all');
  await page.getByLabel('Analytics profiler targets').fill('trino');
  await page.getByRole('button', { name: 'Reset Analytics Profiler defaults' }).click();
  await expect(page.getByLabel('Analytics profiler targets')).toHaveValue('all');
  await page.getByRole('button', { name: 'Run profiler now' }).click();
  await expect(page.getByText('Profiler refresh finished.')).toBeVisible();
  expect(profilerRefreshCalled).toBe(true);
  await expect(page.getByLabel('Analytics profiler enabled')).toBeChecked();
  await page.getByLabel('Analytics profiler enabled').uncheck();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Settings saved. MCP apps were reloaded when needed.')).toBeVisible();
  await expect(page.getByLabel('Analytics profiler enabled')).not.toBeChecked();

  await page.getByRole('button', { name: 'LLM', exact: true }).click();
  await expect(page.getByLabel('LLM API key')).toBeDisabled();
  await expect(page.getByLabel('LLM API base URL')).toBeDisabled();
  await expect(page.getByLabel('Model')).toBeDisabled();
  await expect(page.getByLabel('Extra request body JSON')).toHaveAttribute('placeholder', /metadata/);
  await expect(page.getByLabel('Extra request body JSON')).not.toHaveAttribute('placeholder', /orders contains commerce events/);
  await expect(page.getByRole('button', { name: 'Test LLM connection' })).toBeVisible();
  await page.getByRole('button', { name: 'Test LLM connection' }).click();
  await expect(page.getByText('LLM responded from fixture.')).toBeVisible();
  expect(testBody?.target).toBe('llm');
  expect(testBody?.values || {}).not.toHaveProperty('OPENAI_API_KEY');

  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Master insecure TLS')).toBeDisabled();

  await page.getByRole('button', { name: 'MCP Apps', exact: true }).click();
  await expect(page.getByLabel('MCP enabled apps')).toBeVisible();
  await expect(page.getByLabel('MCP enabled tools')).toBeVisible();
  await expect(page.getByLabel('MCP read-only mode')).toBeChecked();

  await page.getByRole('button', { name: 'Visualization Contract', exact: true }).click();
  await expect(page.getByLabel('Viz theme')).toBeVisible();
  await expect(page.getByLabel('Prefer native app features')).toBeVisible();
  await page.getByLabel('Viz theme').fill('dark');
  await expect(page.getByLabel('Viz theme')).toHaveValue('dark');
  await page.getByRole('button', { name: 'Reset Visualization Contract defaults' }).click();
  await expect(page.getByLabel('Viz theme')).toHaveValue('light');

  await page.getByRole('button', { name: 'Domain Knowledge', exact: true }).click();
  await expect(page.getByLabel('Domain knowledge', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Domain knowledge', { exact: true })).toHaveAttribute('placeholder', /orders contains commerce events/);
  await page.getByLabel('Domain knowledge', { exact: true }).fill('orders contains commerce events');
  await page.getByRole('button', { name: 'Reset Domain Knowledge defaults' }).click();
  await expect(page.getByLabel('Domain knowledge', { exact: true })).toHaveValue('');

  await page.getByRole('button', { name: 'Elasticsearch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Elastic connection' })).toBeVisible();

  await page.getByRole('button', { name: 'Kibana', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Kibana connection' })).toBeVisible();

  await page.getByRole('button', { name: 'Trino / Starburst', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test Trino connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test Starburst connection' })).toBeVisible();
});

test('does not expose per-user profiler actions in the chat topbar', async ({ page }) => {
  await page.goto(appPath());
  await expect(page.getByRole('button', { name: 'Analyze data source' })).toHaveCount(0);
});

test('reloads MCP apps and tools from the topbar', async ({ page }) => {
  let refreshCalled = false;

  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [{ id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' }]
      })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tools: [] }) });
  });
  await page.route('**/api/apps/refresh', async route => {
    refreshCalled = true;
    expect(route.request().method()).toBe('POST');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
          { id: 'mcp-app-trino', name: 'Trino Visualization', status: 'connected' }
        ],
        tools: [{ appId: 'mcp-app-trino', appName: 'Trino Visualization', name: 'visualize_query', inputSchema: { type: 'object' } }]
      })
    });
  });

  await page.goto(appPath());
  await expect(page.locator('.appItem').filter({ hasText: 'Elastic Dashbuilder' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload MCP apps and tools' }).click();
  await expect(page.locator('.appItem').filter({ hasText: 'Trino Visualization' })).toBeVisible();
  expect(refreshCalled).toBe(true);
});

test('runs one-click live demo from selected apps', async ({ page }) => {
  let demoBody: { appIds?: string[] } | undefined;
  let chatBody: { appIds?: string[]; deepAnalysis?: boolean; messages?: Array<{ role: string; content: string }> } | undefined;

  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
          { id: 'mcp-app-trino', name: 'Trino Visualization', status: 'connected' }
        ]
      })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tools: [
          { appId: 'dashbuilder', appName: 'Elastic Dashbuilder', name: 'create_chart' },
          { appId: 'mcp-app-trino', appName: 'Trino Visualization', name: 'visualize_query' }
        ]
      })
    });
  });
  await page.route('**/api/demo', async route => {
    demoBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'ready',
        title: 'Live demo ready',
        summary: 'Ready to run a live data demo with Elastic Dashbuilder and Trino Visualization.',
        checks: [
          { label: 'MCP apps', ok: true, detail: '2 apps ready' },
          { label: 'MCP tools', ok: true, detail: '2 exposed tools' }
        ],
        appIds: ['dashbuilder', 'mcp-app-trino'],
        requiredConnections: ['llm', 'elastic', 'kibana', 'trino'],
        prompts: [
          {
            label: 'Elastic dashboard',
            narration: 'I will start with a simple live chart that is easy to explain.',
            appIds: ['dashbuilder', 'mcp-app-trino'],
            deepAnalysis: false,
            prompt: 'Create a live, read-only Elastic analytics dashboard demo from the selected app. Use actual available data and generate an interactive preview.'
          }
        ],
        sanity: { ok: true, availableApps: 2, availableTools: 2, demoApps: ['dashbuilder', 'mcp-app-trino'] }
      })
    });
  });
  await page.route('**/api/chat', async route => {
    chatBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        content: 'Live data demo preview ready.',
        followUps: ['Show a different live breakdown.'],
        toolCalls: [
          {
            id: 'live-demo-elastic',
            appId: 'dashbuilder',
            toolName: 'create_chart',
            toolInput: { liveDemo: true },
            toolResult: { content: [] },
            html: '<!doctype html><html><body><main><h1>Elastic live preview</h1></main></body></html>',
            resourceUri: 'ui://rubberband-demo/elastic.html',
            title: 'Elastic live preview'
          }
        ]
      })
    });
  });

  await page.goto(appPath());
  await expect(page.getByLabel('Elastic Dashbuilder')).toBeChecked();
  await expect(page.getByLabel('Trino Visualization')).toBeChecked();
  await page.getByRole('button', { name: 'Run live demo' }).click();

  await expect(page.getByText('Run the one-click Rubberband live demo.')).toHaveCount(0);
  await expect(page.getByText('Canned Questions')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Rubberband Live Demo' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Step 1 of 1: Elastic dashboard' })).toBeVisible();
  await expect(page.getByText('Live data demo preview ready.')).toBeVisible();
  await expect(page.getByText('Elastic live preview')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demo wrap-up' })).toBeVisible();
  await expect(page.getByText('What you can try next:')).toBeVisible();
  await expect(page.getByLabel('Suggested follow-up questions')).toBeVisible();
  expect(demoBody?.appIds).toEqual(['dashbuilder', 'mcp-app-trino']);
  expect(chatBody?.appIds).toEqual(['dashbuilder', 'mcp-app-trino']);
  expect(chatBody?.deepAnalysis).toBe(false);
  expect(chatBody?.messages?.at(-1)?.content).toContain('Use actual available data');
});

test('falls back to a static feature tour when live demo is unavailable', async ({ page }) => {
  let chatCalled = false;

  await page.route('**/api/apps', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apps: [] }) });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tools: [] }) });
  });
  await page.route('**/api/demo', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        status: 'needs_apps',
        title: 'Select an MCP app to run a live demo',
        summary: 'No available MCP apps were found for a live demo.',
        checks: [
          { label: 'MCP apps', ok: false, detail: 'No apps available' },
          { label: 'MCP tools', ok: false, detail: 'No tools discovered' }
        ],
        prompts: [],
        appIds: [],
        sanity: { ok: false, availableApps: 0, availableTools: 0, demoApps: [] }
      })
    });
  });
  await page.route('**/api/chat', async route => {
    chatCalled = true;
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'chat should not be called for fallback demo' }) });
  });

  await page.goto(appPath());
  await page.getByRole('button', { name: 'Run live demo' }).click();

  await expect(page.getByRole('heading', { name: 'Rubberband Demo' })).toBeVisible();
  await expect(page.getByText(/static feature tour/i)).toBeVisible();
  await expect(page.getByText('Rubberband workspace tour')).toBeVisible();
  await expect(page.getByText('Visualization feature tour')).toBeVisible();
  await expect(page.getByText('Live demo flow tour')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wrap-up: what to try next' })).toBeVisible();
  expect(chatCalled).toBe(false);
});

test('recovers gracefully when a live demo step fails', async ({ page }) => {
  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ apps: [{ id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' }] })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tools: [{ appId: 'dashbuilder', appName: 'Elastic Dashbuilder', name: 'create_chart' }] })
    });
  });
  await page.route('**/api/demo', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: 'ready',
        title: 'Live demo ready',
        summary: 'Ready to run a live data demo with Elastic Dashbuilder.',
        checks: [{ label: 'MCP apps', ok: true, detail: '1 app ready' }],
        appIds: ['dashbuilder'],
        prompts: [
          {
            label: 'Deep Analysis wrap-up',
            narration: 'Finally I will switch on Deep Analysis for a broader read.',
            appIds: ['dashbuilder'],
            deepAnalysis: true,
            prompt: 'Run a bounded read-only Deep Analysis wrap-up.'
          }
        ],
        sanity: { ok: true, availableApps: 1, availableTools: 1, demoApps: ['dashbuilder'] }
      })
    });
  });
  await page.route('**/api/chat', async route => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Rubberband hit an error while handling the request.' })
    });
  });

  await page.goto(appPath());
  await page.getByRole('button', { name: 'Run live demo' }).click();

  await expect(page.getByRole('heading', { name: 'Step skipped gracefully: Deep Analysis wrap-up' })).toBeVisible();
  await expect(page.getByText('That step took the scenic route and did not make it back in time.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Demo wrap-up' })).toBeVisible();
  await expect(page.getByText('Skipped gracefully: Deep Analysis wrap-up.')).toBeVisible();
});

test('sends selected MCP app ids and Deep Analysis mode with a chat turn', async ({ page }) => {
  let chatBody: { appIds?: string[]; deepAnalysis?: boolean } | undefined;

  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
          { id: 'security', name: 'Elastic Security', status: 'connected' }
        ]
      })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tools: [] }) });
  });
  await page.route('**/api/chat', async route => {
    chatBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ content: 'selected app response', toolCalls: [] })
    });
  });

  await page.goto(appPath());
  await page.getByLabel('Elastic Security').uncheck();
  await page.getByRole('switch', { name: 'Deep Analysis' }).click();
  await page.getByPlaceholder('Ask for a dashboard, SQL chart, or analytics preview...').fill('use selected app');
  await page.getByTitle('Send').click();

  await expect(page.getByText('selected app response')).toBeVisible();
  expect(chatBody?.appIds).toEqual(['dashbuilder']);
  expect(chatBody?.deepAnalysis).toBe(true);
});

test('remembers selected MCP apps in local history', async ({ page }) => {
  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
          { id: 'security', name: 'Elastic Security', status: 'connected' }
        ]
      })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tools: [] }) });
  });

  await page.goto(appPath());
  await expect(page.getByLabel('Elastic Dashbuilder')).toBeChecked();
  await expect(page.getByLabel('Elastic Security')).toBeChecked();
  await page.getByLabel('Elastic Security').uncheck();

  await page.reload();
  await expect(page.getByLabel('Elastic Dashbuilder')).toBeChecked();
  await expect(page.getByLabel('Elastic Security')).not.toBeChecked();
});

test('collapsed nav app and tool icons expand the nav', async ({ page }) => {
  await page.goto(appPath());
  await page.getByTitle('Collapse navigation').click();
  await expect(page.locator('.shell')).toHaveClass(/navCollapsed/);

  await page.getByTitle('Expand apps').click();
  await expect(page.locator('.shell')).not.toHaveClass(/navCollapsed/);
});

test('tools section starts collapsed and groups capabilities by app', async ({ page }) => {
  let toolCallBody: { arguments?: Record<string, unknown> } | undefined;
  let toolCallUrl = '';

  await page.route('**/api/apps', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          { id: 'dashbuilder', name: 'Elastic Dashbuilder', status: 'connected' },
          { id: 'mcp-app-trino', name: 'Trino Visualization', status: 'connected' }
        ]
      })
    });
  });
  await page.route('**/api/tools', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tools: [
          {
            appId: 'dashbuilder',
            appName: 'Elastic Dashbuilder',
            name: 'view_dashboard',
            description: 'Display the full dashboard inline in chat.',
            _meta: { ui: { resourceUri: 'ui://dashbuilder/dashboard.html' } }
          },
          {
            appId: 'dashbuilder',
            appName: 'Elastic Dashbuilder',
            name: 'run_esql',
            description: 'Execute an ES|QL query.'
          },
          {
            appId: 'mcp-app-trino',
            appName: 'Trino Visualization',
            name: 'visualize_query',
            description: 'Execute SQL and render an interactive preview.',
            inputSchema: {
              type: 'object',
              properties: {
                sql: { type: 'string' },
                chartType: { type: 'string', default: 'table' }
              }
            },
            _meta: { ui: { resourceUri: 'ui://mcp-app-trino/chart-preview.html' } }
          },
          ...Array.from({ length: 24 }, (_, index) => ({
            appId: 'mcp-app-trino',
            appName: 'Trino Visualization',
            name: `diagnostic_tool_${index + 1}`,
            description: 'Synthetic tool used to verify sidebar scrolling.'
          }))
        ]
      })
    });
  });
  await page.route('**/api/apps/*/tools/call?*', async route => {
    toolCallUrl = route.request().url();
    toolCallBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, rows: [{ answer: 1 }] })
    });
  });

  await page.goto(appPath());
  await expect(page.locator('.toolGroup')).toHaveCount(0);
  await expect(page.locator('.historyItem')).toHaveCount(0);
  await expect(page.locator('.appItem')).toHaveCount(2);

  await page.getByRole('button', { name: /Tools/ }).click();
  await expect(page.locator('.toolGroup')).toHaveCount(2);
  await expect(page.locator('.toolGroup').filter({ hasText: 'Elastic Dashbuilder' })).toBeVisible();
  await expect(page.locator('.toolGroup').filter({ hasText: 'Trino Visualization' })).toBeVisible();
  await expect(page.getByRole('button', { name: /visualize query/i })).toHaveCount(0);

  await page.locator('.toolGroupHeader').filter({ hasText: 'Trino Visualization' }).click();
  await expect(page.locator('.toolGroup').filter({ hasText: 'Trino Visualization' })).toContainText('visualize query');
  const trinoToolBody = page.locator('.toolGroup').filter({ hasText: 'Trino Visualization' }).locator('.toolGroupBody');
  const toolBodyScrolls = await trinoToolBody.evaluate(element => element.scrollHeight > element.clientHeight);
  expect(toolBodyScrolls).toBe(true);
  const navSections = await page.locator('.sideSection').evaluateAll(sections =>
    sections.map(section => {
      const rect = section.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    })
  );
  expect(navSections[0].bottom).toBeLessThanOrEqual(navSections[1].top);
  expect(navSections[1].bottom).toBeLessThanOrEqual(navSections[2].top);
  await page.getByRole('button', { name: /visualize query/i }).click();
  await expect(page.getByText('Test tool')).toBeVisible();
  await expect(page.getByText('Input schema')).toBeVisible();
  await expect(page.locator('.toolRunnerDrawer')).toBeVisible();
  await expect(page.locator('.toolList .toolRunnerDrawer')).toHaveCount(0);
  await page.getByLabel('Arguments JSON').fill('{"sql":"select 1","chartType":"table"}');
  await page.getByRole('button', { name: 'Run tool' }).click();
  await expect(page.locator('.toolRunnerOutput').filter({ hasText: '"ok": true' })).toBeVisible();
  expect(toolCallUrl).toContain('/api/apps/mcp-app-trino/tools/call?name=visualize_query');
  expect(toolCallBody?.arguments?.sql).toBe('select 1');

  await trinoToolBody.evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.getByRole('button', { name: /diagnostic tool 24/i })).toBeVisible();
});

function normalizeBasePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, '');
  return withoutTrailingSlash === '/' ? '' : withoutTrailingSlash;
}
