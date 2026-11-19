'use strict';
// A QuickLine API selling one eSIM package with free eSIM numbers, for the shop's tests: the shop sells eSIMs only,
// each on a number its supplier has free. Set QL_BASE to url() before the server is loaded, then esimPackage() signs
// in, syncs and puts the package on sale.
const http = require('node:http');

const JWT = 'header.payload.signature';
const QR = 'iVBORw0KGgo=';
const USER = { email: 'dealer@example.com', password: 'ql-pass-123' };

function fakeQuickLine({ count = 40, prefix = '0581000' } = {}) {
  const state = {
    created: [], added: [], down: false,
    esim: Array.from({ length: count }, (_, i) => ({ id: 9000 + i, phone: `${prefix}${String(i).padStart(10 - prefix.length, '0')}`, sim: `89972020${String(i).padStart(10, "0")}`, barcodeImage: QR })),
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
      const text = (v, status = 200) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(v); };
      if (state.down) return text('down', 503);
      const url = req.url.replace(/^\/api\//, '');
      const f = body ? JSON.parse(body) : {};
      if (url === 'Account/Login') {
        if (f.email !== USER.email || f.password !== USER.password) return text('خطأ', 401);
        return json({ statusCode: 200, data: { jwt: JWT, userId: 'u1', type: 'Dealer', name: 'أحمد', email: f.email } });
      }
      if (req.headers.authorization !== `Bearer ${JWT}`) return text('unauthorized', 401);
      if (url === 'Companies/GetDealerCompanies') return json([{ id: 3, name: 'Golan', logo: 'c.jpg', color: '#72206A', postalCode: '89972020', simLength: 18 }]);
      if (url === 'Packages/GetPackagesByCompany/3') {
        return json([{
          company: { id: 3, name: 'Golan', logo: 'c.jpg', color: '#72206A' },
          package: { name: 'جولان 400 جيجا', id: 2564, gb: 400, sms: 5000, minutes: 5000, isOffer: false, offer: null, hasFakePrice: false },
          prices: { pricePerCustomer: 100, pricePerCustomerOffer: 100, fakePrice: null, cost: 62, costOffer: 62, secondaryPrice: 62, mainPrice: 62 },
          dealerId: 4606,
        }]);
      }
      if (url === 'Numbers/GetFreeNumbers') {
        const skip = new Set((f.Numbers || []).map(Number));
        const sold = new Set(state.added.map((s) => s.number));
        return json(f.isEsim ? state.esim.filter((n) => !skip.has(n.id) && !sold.has(n.phone)) : []);
      }
      if (url === 'Subscriptions/DealersGetAllDT') {
        return json({ draw: f.draw, recordsTotal: state.added.length, recordsFiltered: state.added.length, data: state.added.slice(f.start, f.start + f.length).map((s, i) => ({
          company: { name: 'Golan', id: 3, simPrefix: '89972020', simLength: 18 }, package: { name: 'جولان 400 جيجا', id: 2564, gb: 400 },
          customer: { name: 'زبون', id: 1 }, daysLeft: { value: 30, color: 'success' }, status: { name: 'جديد', value: 'info', valueInt: 1 },
          automaticRenew: { name: 'غير فعال', text: 'danger', value: false },
          subscription: { id: s.id, phoneNumber: s.number, simNumber: s.sim, customerPrice: null, isEsim: { name: 'نعم', value: 'success', valueInt: 1 } },
          constantRenew: { name: 'غير فعال', text: 'danger', value: false },
          actions: { canExtend: false, canDisconnect: true, canPause: true, canChangeSim: true, canChangeAutomaticRenew: true, canRefresh: true },
          cutDate: '20/11/2026', connectionDate: '21/10/2026', updateDate: '21/10/2026', dealer: { id: 4606, name: 'أحمد', phone: '0534559260' }, belongsToUser: true, number: i + 1,
        })) });
      }
      if (url === 'Subscriptions/NewSubscription') {
        state.created.push(f);
        const n = state.esim.find((x) => x.id === Number(f.numberId));
        state.added.push({ id: 500000 + state.added.length, number: n.phone, sim: n.sim });
        return text('تمت إضافة الاشتراك بنجاح');
      }
      return text('not found', 404);
    });
  });
  return {
    state, server, QR,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`))),
    close: () => server.close(),
    // Signs the shop in to QuickLine, syncs its new lines and sells the eSIM package at this customer price.
    async esimPackage(call, ok, admin, shopPrice) {
      await ok(call(admin, 'PUT', '/api/settings', { qlUser: USER.email, qlPass: USER.password }));
      await ok(call(admin, 'POST', '/api/quickline/sync', { kind: 'invoice' }));
      const pkg = (await ok(call(admin, 'GET', '/api/catalog'))).packages.find((p) => p.supplier === 'ql' && p.kind === 'invoice');
      await ok(call(admin, 'PUT', `/api/packages/${pkg.id}`, { shopPrice }));
      return { ...pkg, shopPrice };
    },
  };
}

module.exports = { fakeQuickLine, QR };
