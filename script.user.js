// ==UserScript==
// @name         Skins/Advanced fox
// @namespace    https://github.com/Vadim0102/skins-advanced
// @version      1.3.0
// @description  Steam price comparison for csgo-skins.com
// @author       Vadim0102
// @match        https://csgo-skins.com/*
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @updateURL    https://raw.githubusercontent.com/Vadim0102/skins-advanced/main/script.user.js
// @downloadURL  https://raw.githubusercontent.com/Vadim0102/skins-advanced/main/script.user.js
// ==/UserScript==

(function () {
    'use strict';

    const PREFIX = '[CSGO-SKINS]';
    const CACHE_TTL = 24 * 60 * 60 * 1000;
    const REQUEST_DELAY = 1800;
    const RATE_LIMIT_DELAY = 30000;

    const queue = [];
    let queueRunning = false;
    let rateLimitUntil = 0;

    const log = (...args) => console.log(PREFIX, ...args);
    const warn = (...args) => console.warn(PREFIX, ...args);
    const error = (...args) => console.error(PREFIX, ...args);

    function cacheKey(name) { return 'steam_price_' + name; }

    function getCachedPrice(name) {
        try {
            const raw = localStorage.getItem(cacheKey(name));
            if (!raw) return undefined;
            const data = JSON.parse(raw);
            if (Date.now() - data.time > CACHE_TTL) {
                localStorage.removeItem(cacheKey(name));
                return undefined;
            }
            return data.price;
        } catch (e) {
            return undefined;
        }
    }

    function setCachedPrice(name, price) {
        localStorage.setItem(cacheKey(name), JSON.stringify({ price, time: Date.now() }));
    }

    function parsePrice(str) {
        if (!str) return null;
        const match = str.match(/[\d.,]+/);
        if (!match) return null;
        const value = Number(match[0].replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(value) ? value : null;
    }

    function fetchSteamPrice(name, itemNode) {
        return new Promise(resolve => {
            const cached = getCachedPrice(name);
            if (cached !== undefined) {
                resolve(cached);
                return;
            }
            queue.push({ name, resolve, itemNode });
            runQueue();
        });
    }

    async function runQueue() {
        if (queueRunning) return;
        queueRunning = true;

        while (queue.length) {
            if (Date.now() < rateLimitUntil) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const { name, resolve, itemNode } = queue.shift();

            if (getCachedPrice(name) !== undefined) {
                resolve(getCachedPrice(name));
                continue;
            }

            if (itemNode && !itemNode.isConnected) {
                resolve(null);
                continue;
            }

            log('Requesting Steam:', name);

            await new Promise(done => {
                const url = `https://steamcommunity.com/market/priceoverview/?currency=5&appid=730&market_hash_name=${encodeURIComponent(name)}`;
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 15000,
                    onload: response => {
                        if (response.status === 429) {
                            warn('Steam 429 Limit. Pausing 30s...');
                            rateLimitUntil = Date.now() + RATE_LIMIT_DELAY;
                            queue.unshift({ name, resolve, itemNode });
                            return done();
                        }
                        try {
                            const data = JSON.parse(response.responseText);
                            let price = null;
                            if (data?.lowest_price) price = parsePrice(data.lowest_price);
                            if (price === null && data?.median_price) price = parsePrice(data.median_price);

                            setCachedPrice(name, price);
                            resolve(price);
                        } catch (e) {
                            setCachedPrice(name, null);
                            resolve(null);
                        }
                        done();
                    },
                    onerror: () => { resolve(null); done(); }
                });
            });
            await new Promise(r => setTimeout(r, REQUEST_DELAY));
        }
        queueRunning = false;
    }

    // Умное извлечение и определение точки вставки для разных блоков
    function extractItemData(item) {
        // Тип 1: Рулетка / старые карточки
        if (item.classList.contains('ItemSelectorItem')) {
            const name = item.getAttribute('title') || item.querySelector('.ItemSelectorItem_name')?.textContent?.trim();
            const priceNode = item.querySelector('.ItemSelectorItem_value .value_content');
            return {
                name,
                sitePrice: parsePrice(priceNode?.textContent),
                target: priceNode?.parentElement || item,
                action: 'append' // Добавляем в конец контейнера
            };
        }

        // Тип 2: Инвентарь
        if (item.classList.contains('InventoryItem')) {
            const nameNode = item.querySelector('.InventoryItem_name');
            const conditionNode = item.querySelector('.details_detail');
            const priceNode = item.querySelector('.InventoryItem_price .price_value');
            const bottomBlock = item.querySelector('.InventoryItem_bottom'); // Блок с кнопками "продать/вывести"

            if (!nameNode) return null;
            let name = nameNode.textContent.trim();

            if (conditionNode) {
                const condition = conditionNode.textContent.trim();
                if (condition && !name.includes(condition)) {
                    name = `${name} (${condition})`;
                }
            }

            return {
                name,
                sitePrice: parsePrice(priceNode?.textContent),
                target: bottomBlock || item,
                action: bottomBlock ? 'before' : 'append',
                isInventory: true // Флаг для стилей
            };
        }
        return null;
    }

    function getColor(diffPercent) {
        if (diffPercent >= 15) return '#55ff88';
        if (diffPercent <= -15) return '#ff6666';
        return '#ffffff';
    }

    function addGlow(item, diffPercent) {
        if (diffPercent >= 15) {
            item.style.boxShadow = '0 0 12px rgba(0,255,100,.5)';
        } else if (diffPercent <= -15) {
            item.style.boxShadow = '0 0 12px rgba(255,0,0,.45)';
        }
    }

    function createLink(text, href) {
        const a = document.createElement('a');
        a.textContent = text;
        a.href = href;
        a.target = '_blank';
        a.style.cssText = `color: #8fc4ff; text-decoration: none; cursor: pointer; position: relative; z-index: 999;`;
        return a;
    }

    // Базовые стили для контейнера скрипта
    function getBaseStyles(isInventory) {
        if (isInventory) {
            return `
                margin: 0 16px 10px 16px;
                padding-top: 8px;
                border-top: 1px solid rgba(255,255,255,0.05);
                font-size: 12px;
                line-height: 1.4;
                width: calc(100% - 32px);
                display: block;
                text-align: left;
            `;
        }
        return `
            margin-top: 6px;
            font-size: 12px;
            line-height: 1.35;
            width: 100%;
            display: block;
        `;
    }

    function createNotFoundBlock(itemName, isInventory) {
        const wrap = document.createElement('div');
        wrap.style.cssText = getBaseStyles(isInventory) + 'color: #aaaaaa;';
        wrap.innerHTML = `<div>Steam: N/A</div>`;
        const links = document.createElement('div');
        links.style.cssText = `margin-top: 4px; display: flex; gap: 8px;`;
        links.appendChild(createLink('CSFloat', `https://csfloat.com/search?market_hash_name=${encodeURIComponent(itemName)}`));
        wrap.appendChild(links);
        return wrap;
    }

    function createCompareBlock(itemName, sitePrice, steamPrice, isInventory) {
        const diff = steamPrice - sitePrice;
        const diffPercent = (diff / sitePrice) * 100;
        const color = getColor(diffPercent);
        const arrow = diff >= 0 ? '▲' : '▼';

        const wrap = document.createElement('div');
        wrap.style.cssText = getBaseStyles(isInventory) + `color: ${color};`;

        wrap.innerHTML = `
            <div>Steam: ${steamPrice.toFixed(2)} ₽</div>
            <div>${arrow} ${Math.abs(diff).toFixed(2)} ₽ (${diffPercent.toFixed(1)}%)</div>
            <div>x${(steamPrice / sitePrice).toFixed(2)}</div>
        `;

        const links = document.createElement('div');
        links.style.cssText = `margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap;`;
        links.appendChild(createLink('Steam', `https://steamcommunity.com/market/listings/730/${encodeURIComponent(itemName)}`));
        links.appendChild(createLink('CSFloat', `https://csfloat.com/search?market_hash_name=${encodeURIComponent(itemName)}`));
        wrap.appendChild(links);

        return { element: wrap, diffPercent };
    }

    async function processItem(item) {
        if (item.dataset.steamEnhanced === '1') return;
        item.dataset.steamEnhanced = '1';

        const data = extractItemData(item);
        if (!data || !data.name || !data.sitePrice) return;

        const steamPrice = await fetchSteamPrice(data.name, item);
        if (!item.isConnected) return; // Защита от пропажи предмета из DOM

        let blockElement;
        if (steamPrice === null || steamPrice <= 0) {
            blockElement = createNotFoundBlock(data.name, data.isInventory);
        } else {
            const result = createCompareBlock(data.name, data.sitePrice, steamPrice, data.isInventory);
            addGlow(item, result.diffPercent);
            blockElement = result.element;
        }

        // Вставка в нужное место в зависимости от типа карточки
        if (data.action === 'before' && data.target.parentNode) {
            data.target.parentNode.insertBefore(blockElement, data.target);
        } else {
            if (!data.isInventory && data.target.style) data.target.style.flexWrap = 'wrap';
            data.target.appendChild(blockElement);
        }
    }

    function scan() {
        const items = document.querySelectorAll('.ItemSelectorItem:not([data-steam-enhanced="1"]), .InventoryItem:not([data-steam-enhanced="1"])');
        items.forEach(processItem);
    }

    let scanTimeout;
    const observer = new MutationObserver(() => {
        clearTimeout(scanTimeout);
        scanTimeout = setTimeout(scan, 250);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    log('started');
    scan();

})();
