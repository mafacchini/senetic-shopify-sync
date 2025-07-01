require('dotenv').config();
const express = require('express');
const axios = require('axios');
const he = require('he');

const app = express();

const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

app.get('/import-shopify', async (req, res) => {
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

    // Limita a massimo 5 prodotti per test veloce
    const prodottiDaImportare = prodottiFiltrati.slice(0, 5);

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
              weight: prodotto.weight ? Number(prodotto.weight) : 0,
              weight_unit: "kg",
            }
          ]
        }
      };

      try {
        // ✅ FORZA CREAZIONE (senza cercare esistenti per evitare sovrascrizioni)
        console.log(`🆕 Creando: ${prodotto.manufacturerItemCode}`);
        
        const createResult = await axios.post(
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
          status: 'ok',
          shopify_id: createResult.data.product.id
        });

      } catch (err) {
        risultati.push({
          title: shopifyProduct.product.title,
          sku: shopifyProduct.product.variants[0].sku,
          status: 'errore',
          error: err.response?.data || err.message
        });
      }

      await new Promise(r => setTimeout(r, 200)); // Delay ridotto
    }

    res.json({ 
      message: 'Importazione completata!', 
      risultati,
      stats: {
        processed: prodottiDaImportare.length,
        success: risultati.filter(r => r.status === 'ok').length,
        errors: risultati.filter(r => r.status === 'errore').length
      }
    });

  } catch (error) {
    console.error('Errore:', error);
    res.status(500).json({ error: error.toString() });
  }
});

app.get('/', (req, res) => {
  res.json({
    message: 'Senetic-Shopify Sync API',
    endpoints: {
      'import': '/import-shopify'
    }
  });
});

app.get('/import-shopify-cron', async (req, res) => {
  // Verifica token di sicurezza
  const authHeader = req.headers['x-cron-token'];
  if (authHeader !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Token non valido' });
  }

  console.log('✅ Token CRON valido - avvio sincronizzazione');

  // Stesso codice dell'endpoint normale ma con più prodotti
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

    // Limita a massimo 20 prodotti per test veloce
    const prodottiDaImportare = prodottiFiltrati.slice(0, 20);

    for (const prodotto of prodottiDaImportare) {
      const inventoryItem = inventoryMap[prodotto.manufacturerItemCode];
      if (!inventoryItem) continue;

      const availability = inventoryItem.availability && Array.isArray(inventoryItem.availability.stockSchedules)
        ? inventoryItem.availability.stockSchedules.reduce((sum, s) => sum + (s.targetStock || 0), 0)
        : 0;

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
              weight: prodotto.weight ? Number(prodotto.weight) : 0,
              weight_unit: "kg",
            }
          ]
        }
      };

      try {
        // 🔍 CERCA PRODOTTO ESISTENTE per SKU - METODO MIGLIORATO
        console.log(`🔍 [CRON] Cercando prodotto esistente: ${prodotto.manufacturerItemCode}`);
        
        // Usa l'endpoint products con filtro SKU invece di variants
        const searchResponse = await axios.get(
          `${SHOPIFY_STORE_URL}/admin/api/2024-04/products.json?limit=250`,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );

        const allProducts = searchResponse.data.products || [];
        
        // Trova il prodotto con la variante che ha questo SKU specifico
        let existingProduct = null;
        let existingVariant = null;
        
        for (const product of allProducts) {
          const variant = product.variants.find(v => v.sku === prodotto.manufacturerItemCode);
          if (variant) {
            existingProduct = product;
            existingVariant = variant;
            break;
          }
        }

        if (existingProduct && existingVariant) {
          // ✅ PRODOTTO ESISTENTE - AGGIORNA
          const productId = existingProduct.id;
          const variantId = existingVariant.id;

          console.log(`🔄 [CRON] Aggiornando prodotto esistente: ${prodotto.manufacturerItemCode} (Product ID: ${productId}, Variant ID: ${variantId})`);

          // 1. Aggiorna solo i dati del prodotto
          await axios.put(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/products/${productId}.json`,
            {
              product: {
                id: productId,
                title: shopifyProduct.product.title,
                body_html: shopifyProduct.product.body_html,
                vendor: shopifyProduct.product.vendor,
                product_type: shopifyProduct.product.product_type
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );

          // 2. Aggiorna la variante specifica
          await axios.put(
            `${SHOPIFY_STORE_URL}/admin/api/2024-04/variants/${variantId}.json`,
            {
              variant: {
                id: variantId,
                price: shopifyProduct.product.variants[0].price,
                cost: shopifyProduct.product.variants[0].cost,
                inventory_quantity: availability,
                barcode: shopifyProduct.product.variants[0].barcode,
                weight: shopifyProduct.product.variants[0].weight,
                weight_unit: shopifyProduct.product.variants[0].weight_unit
              }
            },
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json'
              }
            }
          );
          
          risultati.push({
            title: shopifyProduct.product.title,
            price: shopifyProduct.product.variants[0].price,
            sku: shopifyProduct.product.variants[0].sku,
            status: 'aggiornato',
            shopify_id: productId,
            action: 'updated',
            variant_id: variantId
          });

        } else {
          // 🆕 PRODOTTO NUOVO - CREA
          console.log(`🆕 [CRON] Creando nuovo prodotto: ${prodotto.manufacturerItemCode}`);
          
          const createResult = await axios.post(
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
            status: 'creato',
            shopify_id: createResult.data.product.id,
            action: 'created'
          });
        }

      } catch (err) {
        console.error(`❌ [CRON] Errore ${prodotto.manufacturerItemCode}:`, err.message);
        risultati.push({
          title: shopifyProduct.product?.title || 'Unknown',
          sku: prodotto.manufacturerItemCode,
          status: 'errore',
          error: err.message,
          action: 'error'
        });
      }

      // Rate limiting più lungo per evitare problemi
      await new Promise(r => setTimeout(r, 800));
    }

    res.json({ 
      message: 'Sincronizzazione CRON completata!', 
      risultati,
      stats: {
        processed: prodottiDaImportare.length,
        created: risultati.filter(r => r.action === 'created').length,
        updated: risultati.filter(r => r.action === 'updated').length,
        errors: risultati.filter(r => r.action === 'error').length,
        total_success: risultati.filter(r => r.status === 'creato' || r.status === 'aggiornato').length
      },
      type: 'cron_job',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Errore CRON:', error);
    res.status(500).json({ error: error.toString() });
  }
});

// Aggiungi questo nuovo endpoint in api/index.js:

app.get('/sync-single-product/:sku', async (req, res) => {
  const sku = req.params.sku;
  
  // Verifica token di sicurezza
  const authToken = req.headers['x-sync-token'];
  if (authToken !== process.env.SYNC_TOKEN) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  try {
    console.log(`🔍 [SINGLE] Sincronizzazione prodotto: ${sku}`);

    // 1. Ottieni dati da Senetic per questo SKU specifico
    const seneticResponse = await axios.get(
      `https://api.senetic.pl/api/products?filter[manufacturerItemCode]=${sku}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.SENETIC_AUTH}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const prodotto = seneticResponse.data.data.find(p => p.manufacturerItemCode === sku);
    
    if (!prodotto) {
      return res.status(404).json({ 
        error: 'Prodotto non trovato su Senetic',
        sku: sku
      });
    }

    // 2. Calcola disponibilità
    const availability = prodotto.stockQuantity > 0 ? 
      Math.min(prodotto.stockQuantity, 100) : 0;

    // 3. Costruisci prodotto Shopify
    const shopifyProduct = {
      product: {
        title: prodotto.itemDescription || '',
        body_html: prodotto.longItemDescription ? he.decode(prodotto.longItemDescription) : '',
        vendor: prodotto.productPrimaryBrand?.brandNodeName || '',
        product_type: prodotto.productSecondaryCategory?.categoryNodeName || '',
        variants: [{
          price: prodotto.unitRetailPrice ? 
            (prodotto.unitRetailPrice * (1 + (prodotto.taxRate ? prodotto.taxRate / 100 : 0))).toFixed(2) : "0.00",
          cost: prodotto.unitNetPrice ? prodotto.unitNetPrice.toString() : "0.00",
          sku: prodotto.manufacturerItemCode || '',
          barcode: prodotto.ean ? String(prodotto.ean) : '',
          inventory_quantity: availability,
          inventory_management: "shopify",
          weight: prodotto.weight ? Number(prodotto.weight) : 0,
          weight_unit: "kg",
        }]
      }
    };

    // 4. Cerca prodotto esistente su Shopify
    const searchResponse = await axios.get(
      `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-04/products.json?limit=250`,
      {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const allProducts = searchResponse.data.products || [];
    let existingProduct = null;
    let existingVariant = null;
    
    for (const product of allProducts) {
      const variant = product.variants.find(v => v.sku === sku);
      if (variant) {
        existingProduct = product;
        existingVariant = variant;
        break;
      }
    }

    if (existingProduct && existingVariant) {
      // 5. Aggiorna prodotto esistente
      const productId = existingProduct.id;
      const variantId = existingVariant.id;

      console.log(`🔄 [SINGLE] Aggiornando prodotto: ${sku} (ID: ${productId})`);

      // Aggiorna variante (prezzi, inventario)
      await axios.put(
        `${process.env.SHOPIFY_STORE_URL}/admin/api/2024-04/variants/${variantId}.json`,
        {
          variant: {
            id: variantId,
            price: shopifyProduct.product.variants[0].price,
            cost: shopifyProduct.product.variants[0].cost,
            inventory_quantity: availability,
            barcode: shopifyProduct.product.variants[0].barcode,
            weight: shopifyProduct.product.variants[0].weight,
            weight_unit: shopifyProduct.product.variants[0].weight_unit
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      res.json({
        success: true,
        action: 'updated',
        sku: sku,
        shopify_id: productId,
        variant_id: variantId,
        price: shopifyProduct.product.variants[0].price,
        inventory: availability,
        timestamp: new Date().toISOString()
      });

    } else {
      res.status(404).json({
        success: false,
        error: 'Prodotto non trovato su Shopify',
        sku: sku,
        action: 'not_found'
      });
    }

  } catch (error) {
    console.error(`❌ [SINGLE] Errore ${sku}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      sku: sku,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = app;