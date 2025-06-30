require('dotenv').config();
const axios = require('axios');

// Per decodificare i caratteri HTML, se necessario
const he = require('he');

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

class Controller {
  async importToShopify(req, res) {
    try {
      // 1. Recupera inventario e catalogo
      const [inventoryResponse, catalogueResponse] = await Promise.all([
        axios.get(
          'https://b2b.senetic.com/Gateway/ClientApi/InventoryReportGet?UseItemCategoryFilter=true&LangId=IT',
          {
            headers: {
              'accept': 'application/json',
              'Authorization': process.env.SENETIC_AUTH,
              'User-Agent': 'Mozilla/5.0'
            }
          }
        ),
        axios.get(
          'https://b2b.senetic.com/Gateway/ClientApi/ProductCatalogueGet?UseItemCategoryFilter=true&LangId=IT',
          {
            headers: {
              'accept': 'application/json',
              'Authorization': process.env.SENETIC_AUTH,
              'User-Agent': 'Mozilla/5.0'
            }
          }
        )
      ]);
      const inventoryLines = inventoryResponse.data.lines || [];
      const catalogueLines = catalogueResponse.data.lines || [];

      // Puoi aggiungere qui tutte le categorie che vuoi filtrare
      const categorieDesiderate = [
        'Sistemi di sorveglianza',
        'Reti'
      ].map(c => c.trim().toLowerCase());

      // Puoi aggiungere qui tutti i brand che vuoi filtrare
      const brandDesiderati = [
        'Hikvision',
        'Ubiquiti'
      ].map(b => b.trim().toLowerCase());

      // 2. Crea una mappa inventario per manufacturerItemCode
      const inventoryMap = {};
      for (const item of inventoryLines) {
        if (item.manufacturerItemCode) {
          inventoryMap[item.manufacturerItemCode] = item;
        }
      }

      // 3. Prepara i prodotti da importare
      const risultati = [];
      const prodottiFiltrati = catalogueLines.filter(
        prodotto =>
          prodotto.productSecondaryCategory &&
          prodotto.productSecondaryCategory.categoryNodeName &&
          categorieDesiderate.includes(prodotto.productSecondaryCategory.categoryNodeName.trim().toLowerCase()) &&
          prodotto.productPrimaryBrand &&
          prodotto.productPrimaryBrand.brandNodeName &&
          brandDesiderati.includes(prodotto.productPrimaryBrand.brandNodeName.trim().toLowerCase())
      );

      // Limita a massimo 10 prodotti
      const prodottiDaImportare = prodottiFiltrati.slice(0, 10);

      for (const prodotto of prodottiDaImportare) {
        // Cerca il prodotto nell'inventario tramite manufacturerItemCode
        const inventoryItem = inventoryMap[prodotto.manufacturerItemCode];
        if (!inventoryItem) continue; // Salta se non presente in inventario

        // Calcola la quantità totale disponibile
        const availability = inventoryItem.availability && Array.isArray(inventoryItem.availability.stockSchedules)
          ? inventoryItem.availability.stockSchedules.reduce((sum, s) => sum + (s.targetStock || 0), 0)
          : 0;

        // Costruisci il prodotto per Shopify
        const shopifyProduct = {
          product: {
            title: prodotto.itemDescription || '',
            body_html: prodotto.longItemDescription ? he.decode(prodotto.longItemDescription) : '',
            vendor: prodotto.productPrimaryBrand?.brandNodeName || '',
            product_type: prodotto.productSecondaryCategory?.categoryNodeName || '',
            variants: [
              {
                price: prodotto.unitRetailPrice ? (prodotto.unitRetailPrice * (1 + (prodotto.taxRate ? prodotto.taxRate / 100 : 0))).toFixed(2) : "0.00",
                cost: prodotto.unitNetPrice ? prodotto.unitNetPrice.toString() : "0.00",
                sku: prodotto.manufacturerItemCode || '',
                barcode: prodotto.ean ? String(prodotto.ean) : '',
                inventory_quantity: availability,
                inventory_management: "shopify",
                weight: prodotto.weight ? Number(prodotto.weight) : 0,           // <--- aggiungi questa riga
                weight_unit: "kg",
              }
            ]
          }
        };

        try {
          // Crea il prodotto su Shopify
          // Cerca se esiste già una variante con questa SKU
          const searchRes = await axios.get(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/variants.json?sku=${encodeURIComponent(prodotto.manufacturerItemCode)}`,
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );
          const variants = searchRes.data.variants;
          if (variants && variants.length > 0) {
            // Esiste già: aggiorna il prodotto
            const productId = variants[0].product_id;
            await axios.put(
              `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}.json`,
              shopifyProduct,
              {
                headers: {
                  'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                  'Content-Type': 'application/json'
                }
              }
            );
            risultati.push({
              title: shopifyProduct.product.title,
              body_html: shopifyProduct.product.body_html,
              vendor: shopifyProduct.product.vendor,
              product_type: shopifyProduct.product.product_type,
              price: shopifyProduct.product.variants[0].price,
              cost: shopifyProduct.product.variants[0].cost,
              sku: shopifyProduct.product.variants[0].sku,
              barcode: shopifyProduct.product.variants[0].barcode,
              inventory_quantity: shopifyProduct.product.variants[0].inventory_quantity,
              inventory_management: shopifyProduct.product.variants[0].inventory_management,
              weight: shopifyProduct.product.variants[0].weight,
              weight_unit: shopifyProduct.product.variants[0].weight_unit,
              status: 'ok'
            });
          } else {
            // Non esiste: crea nuovo prodotto
            await axios.post(
              `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json`,
              shopifyProduct,
              {
                headers: {
                  'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                  'Content-Type': 'application/json'
                }
              }
            );
            risultati.push({
              title: shopifyProduct.product.title,
              body_html: shopifyProduct.product.body_html,
              vendor: shopifyProduct.product.vendor,
              product_type: shopifyProduct.product.product_type,
              price: shopifyProduct.product.variants[0].price,
              cost: shopifyProduct.product.variants[0].cost,
              sku: shopifyProduct.product.variants[0].sku,
              barcode: shopifyProduct.product.variants[0].barcode,
              inventory_quantity: shopifyProduct.product.variants[0].inventory_quantity,
              inventory_management: shopifyProduct.product.variants[0].inventory_management,
              weight: shopifyProduct.product.variants[0].weight,
              weight_unit: shopifyProduct.product.variants[0].weight_unit,
              status: 'ok'
            });
          }
        } catch (err) {
          risultati.push({
            title: shopifyProduct.product.title,
            sku: shopifyProduct.product.variants[0].sku,
            status: 'errore',
            error: err.response?.data || err.message
          });
        }
        await new Promise(r => setTimeout(r, 500)); // Delay per evitare rate limit
      }

      res.json({ message: 'Importazione completata!', risultati });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.toString() });
    }
  }
}

module.exports = Controller;