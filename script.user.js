// ==UserScript==
// @name         Skins/Advanced fox
// @namespace    https://github.com/Vadim0102/skins-advanced
// @version      1.5.0
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
    let currencyMismatchDetected = false;

    const log = (...args) => console.log(PREFIX, ...args);
    const warn = (...args) => console.warn(PREFIX, ...args);
    const error = (...args) => console.error(PREFIX, ...args);

    const CURRENCY_MAP = {
        '₽': { code: 5, name: 'RUB', symbol: '₽' },
        'RUB': { code: 5, name: 'RUB', symbol: '₽' },
        '$': { code: 1, name: 'USD', symbol: '$' },
        'USD': { code: 1, name: 'USD', symbol: '$' },
        '€': { code: 3, name: 'EUR', symbol: '€' },
        'EUR': { code: 3, name: 'EUR', symbol: '€' },
        'ZŁ': { code: 6, name: 'PLN', symbol: 'zł' },
        'PLN': { code: 6, name: 'PLN', symbol: 'zł' },
        '₺': { code: 17, name: 'TRY', symbol: '₺' },
        'TRY': { code: 17, name: 'TRY', symbol: '₺' }
    };

    function parseSiteCurrency(str) {
        if (!str) return null;
        const s = str.toUpperCase();
        for (const [key, cur] of Object.entries(CURRENCY_MAP)) {
            if (s.includes(key)) return cur;
        }
        return null;
    }

    function getSteamCurrencyCodeFromString(priceStr) {
        if (!priceStr) return null;
        const s = priceStr.toLowerCase();
        if (s.includes('$') || s.includes('usd')) return 1;
        if (s.includes('€') || s.includes('eur')) return 3;
        if (s.includes('p.') || s.includes('руб') || s.includes('₽') || s.includes('rub')) return 5;
        if (s.includes('zł') || s.includes('zl') || s.includes('pln')) return 6;
        if (s.includes('tl') || s.includes('₺') || s.includes('try')) return 17;
        return null;
    }

    function handleCurrencyMismatch(siteCur, steamCode) {
        if (currencyMismatchDetected) return;
        currencyMismatchDetected = true;
        queue.length = 0;
        queueRunning = false;

        const steamCurName = Object.values(CURRENCY_MAP).find(c => c.code === steamCode)?.name || 'Неизвестная валюта';
        warn(`Currency mismatch! Site: ${siteCur.name}, Steam returned: ${steamCurName}`);

        const alertsContainer = document.querySelector('.Alerts') || (() => {
            const c = document.createElement('div');
            c.className = 'Alerts';
            document.body.appendChild(c);
            return c;
        })();

        let alertList = alertsContainer.querySelector('.Alerts_list.list--top-left') || (() => {
            const ul = document.createElement('ul');
            ul.className = 'Alerts_list list--top-left';
            alertsContainer.appendChild(ul);
            return ul;
        })();

        const li = document.createElement('li');
        li.className = 'Alert Alert--error';
        li.style.pointerEvents = 'auto';
        li.innerHTML = `<strong>CSGO-SKINS Compare</strong><br>Несовпадение валют! Steam вернул: ${steamCurName}. Парсинг остановлен.`;
        alertList.appendChild(li);
    }

    // Сбросили кэш на новую версию v3, чтобы удалить все цены с x100 багом
    function cacheKey(name, currencyCode) { return `csgoskins_v3_${currencyCode}_${name}`; }

    function getCachedPrice(name, currencyCode) {
        try {
            const raw = localStorage.getItem(cacheKey(name, currencyCode));
            if (!raw) return undefined;
            const data = JSON.parse(raw);
            if (Date.now() - data.time > CACHE_TTL) {
                localStorage.removeItem(cacheKey(name, currencyCode));
                return undefined;
            }
            return data.price;
        } catch (e) {
            return undefined;
        }
    }

    function setCachedPrice(name, currencyCode, price) {
        localStorage.setItem(cacheKey(name, currencyCode), JSON.stringify({ price, time: Date.now() }));
    }

    // Железобетонный парсер (вернули логику из 1.2.0, но с защитой от тысяч)
    function parsePrice(str) {
        if (!str) return null;
        if (typeof str === 'number') return str;

        const match = str.toString().match(/[\d.,]+/);
        if (!match) return null;

        let s = match[0].replace(/\s/g, '');

        // Защита от цен типа 1,234.50
        if (s.includes('.') && s.includes(',')) {
            if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
                s = s.replace(/\./g, '').replace(',', '.');
            } else {
                s = s.replace(/,/g, '');
            }
        } else if (s.includes(',')) {
            s = s.replace(',', '.');
        }

        const value = parseFloat(s);
        return isNaN(value) ? null : value;
    }

    function fetchSteamPrice(name, itemNode, currency) {
        return new Promise(resolve => {
            const cached = getCachedPrice(name, currency.code);
            if (cached !== undefined) {
                resolve(cached);
                return;
            }
            queue.push({ name, resolve, itemNode, currency });
            runQueue();
        });
    }

    async function runQueue() {
        if (queueRunning) return;
        queueRunning = true;

        while (queue.length) {
            if (currencyMismatchDetected) { queue.length = 0; break; }
            if (Date.now() < rateLimitUntil) { await new Promise(r => setTimeout(r, 1000)); continue; }

            const { name, resolve, itemNode, currency } = queue.shift();

            if (getCachedPrice(name, currency.code) !== undefined) {
                resolve(getCachedPrice(name, currency.code));
                continue;
            }

            if (itemNode && !itemNode.isConnected) {
                resolve(null);
                continue;
            }

            await new Promise(done => {
                const url = `https://steamcommunity.com/market/priceoverview/?currency=${currency.code}&appid=730&market_hash_name=${encodeURIComponent(name)}`;
                GM_xmlhttpRequest({
                    method: 'GET', url, timeout: 15000,
                    onload: response => {
                        if (response.status === 429) {
                            rateLimitUntil = Date.now() + RATE_LIMIT_DELAY;
                            queue.unshift({ name, resolve, itemNode, currency });
                            return done();
                        }
                        try {
                            const data = JSON.parse(response.responseText);
                            let priceStr = data?.lowest_price || data?.median_price;
                            let price = null;

                            if (priceStr) {
                                const steamReturnedCode = getSteamCurrencyCodeFromString(priceStr);
                                if (steamReturnedCode !== null && steamReturnedCode !== currency.code) {
                                    handleCurrencyMismatch(currency, steamReturnedCode);
                                    resolve(null);
                                    return done();
                                }
                                price = parsePrice(priceStr);
                            }

                            setCachedPrice(name, currency.code, price);
                            resolve(price);
                        } catch (e) {
                            setCachedPrice(name, currency.code, null);
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

    function extractItemData(item) {
        if (item.classList.contains('ItemSelectorItem')) {
            const name = item.getAttribute('title') || item.querySelector('.ItemSelectorItem_name')?.textContent?.trim();
            const priceNode = item.querySelector('.ItemSelectorItem_value .value_content');
            if (!priceNode) return null;
            return {
                name,
                sitePrice: parsePrice(priceNode.textContent),
                currency: parseSiteCurrency(priceNode.textContent),
                target: priceNode.parentElement || item,
                action: 'append'
            };
        }

        if (item.classList.contains('InventoryItem')) {
            const nameNode = item.querySelector('.InventoryItem_name');
            const conditionNode = item.querySelector('.details_detail');
            const priceNode = item.querySelector('.InventoryItem_price .price_value');

            // Вставляем безопасно прямо в список качеств (Field-Tested и тд)
            const detailsList = item.querySelector('.InventoryItem_details');

            if (!nameNode || !priceNode) return null;
            let name = nameNode.textContent.trim();

            if (conditionNode) {
                const condition = conditionNode.textContent.trim();
                if (condition && !name.includes(condition)) {
                    name = `${name} (${condition})`;
                }
            }

            return {
                name,
                sitePrice: parsePrice(priceNode.textContent),
                currency: parseSiteCurrency(priceNode.textContent),
                target: detailsList || item,
                action: detailsList ? 'append_li' : 'append',
                isInventory: true
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

    function getBaseStyles(isInventory) {
        if (isInventory) {
            // Стили для элемента <li> внутри списка
            return `
                width: 100%;
                margin-top: 8px;
                padding-top: 8px;
                border-top: 1px dashed rgba(255,255,255,0.15);
                font-size: 11px;
                line-height: 1.4;
                display: block;
                text-align: left;
                list-style: none;
                pointer-events: auto;
            `;
        }
        return `margin-top: 6px; font-size: 12px; line-height: 1.35; width: 100%; display: block; pointer-events: auto;`;
    }

    function createCompareBlock(itemName, sitePrice, steamPrice, isInventory, symbol) {
        const diff = steamPrice - sitePrice;
        const diffPercent = (diff / sitePrice) * 100;
        const color = getColor(diffPercent);
        const arrow = diff >= 0 ? '▲' : '▼';

        const wrap = document.createElement(isInventory ? 'li' : 'div');
        wrap.style.cssText = getBaseStyles(isInventory) + `color: ${color};`;

        wrap.innerHTML = `
            <div>Steam: ${steamPrice.toFixed(2)} ${symbol}</div>
            <div>${arrow} ${Math.abs(diff).toFixed(2)} ${symbol} (${diffPercent.toFixed(1)}%)</div>
            <div>x${(steamPrice / sitePrice).toFixed(2)}</div>
        `;

        const links = document.createElement('div');
        links.style.cssText = `margin-top: 4px; display: flex; gap: 8px; flex-wrap: wrap;`;
        links.appendChild(createLink('Steam', `https://steamcommunity.com/market/listings/730/${encodeURIComponent(itemName)}`));
        links.appendChild(createLink('CSFloat', `https://csfloat.com/search?market_hash_name=${encodeURIComponent(itemName)}`));
        wrap.appendChild(links);

        return { element: wrap, diffPercent };
    }

    function createNotFoundBlock(itemName, isInventory) {
        const wrap = document.createElement(isInventory ? 'li' : 'div');
        wrap.style.cssText = getBaseStyles(isInventory) + 'color: #aaaaaa;';
        wrap.innerHTML = `<div>Steam: N/A</div>`;
        const links = document.createElement('div');
        links.style.cssText = `margin-top: 4px; display: flex; gap: 8px;`;
        links.appendChild(createLink('CSFloat', `https://csfloat.com/search?market_hash_name=${encodeURIComponent(itemName)}`));
        wrap.appendChild(links);
        return wrap;
    }

    async function processItem(item) {
        if (currencyMismatchDetected || item.dataset.steamEnhanced === '1') return;
        item.dataset.steamEnhanced = '1';

        const data = extractItemData(item);
        if (!data || !data.name || !data.sitePrice || !data.currency) return;

        const steamPrice = await fetchSteamPrice(data.name, item, data.currency);
        if (currencyMismatchDetected || !item.isConnected) return;

        let blockElement;
        if (steamPrice === null || steamPrice <= 0) {
            blockElement = createNotFoundBlock(data.name, data.isInventory);
        } else {
            const result = createCompareBlock(data.name, data.sitePrice, steamPrice, data.isInventory, data.currency.symbol);
            addGlow(item, result.diffPercent);
            blockElement = result.element;
        }

        // Безопасная вставка, которая не ломает кнопки сайта
        if (data.action === 'append_li') {
            data.target.style.flexWrap = 'wrap';
            data.target.appendChild(blockElement);
        } else {
            if (!data.isInventory && data.target.style) data.target.style.flexWrap = 'wrap';
            data.target.appendChild(blockElement);
        }
    }

    function scan() {
        if (currencyMismatchDetected) return;
        document.querySelectorAll('.ItemSelectorItem:not([data-steam-enhanced="1"]), .InventoryItem:not([data-steam-enhanced="1"])')
            .forEach(processItem);
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
