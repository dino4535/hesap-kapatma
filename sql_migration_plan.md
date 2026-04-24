# SQL Migration Plan (dist2k)

Bu plan `sql_design.md` tasarimini uygulamaya gecirmek icin hazirlandi.

## Hedef
- JSON verisini anlamli DIM/FACT modeline tasimak.
- Mevcut uygulamayi kesmeden gecis yapmak.
- Son adimda API ve UI tarafini `dist2k` semasina almak.

## Adimlar
1. Faz 1 - Altyapi (tamamlandi)
- `dist2k` semasi olusturuldu.
- `DIM_POSITION`, `DIM_CUSTOMER`, `DIM_PRODUCT` tablolari eklendi.
- `FACT_INVOICE`, `FACT_INVOICE_LINE`, `FACT_INVOICE_PAYMENT`, `FACT_COLLECTION` tablolari eklendi.
- Operasyonel filtreler icin `source_file_*` kolonlari eklendi.

2. Faz 2 - Veri senkronizasyonu (tamamlandi)
- Gecis surecinde `dbo` kaynak tablolardan `dist2k` tablolara tam yeniden kurulum senkronu kullanildi.
- Bu adim, API gecisi tamamlanana kadar gecici uyumluluk icin kullanildi.

3. Faz 3 - API gecisi (tamamlandi)
- `/api/positions` ve `/api/positions/:code` sorgulari `dist2k` tablolardan besleniyor.
- Cikti modeli (frontend contract) korunarak SQL source degistirildi.
- `dbo` fallback devre disi birakildi.

4. Faz 4 - Import yeniden yazimi (tamamlandi)
- Import katmani dogrudan `dist2k` tablolara yaziyor.
- Admin veri silme endpointleri de dogrudan `dist2k` fakt tablolarina calisiyor.
- `rebuildDist2kFromDbo` operasyon endpointi deprecate/no-op durumuna alindi.

5. Faz 5 - Frontend sadelestirme (planlandi)
- Allocation ve ozet hesaplari `dist2k` sorgularina gore optimize edilecek.
- Nakit/Havale/Vadeli hesaplari icin SQL tarafinda hazir aggregate endpointleri eklenecek.
- UI hesaplarinda ayni formulu hem detay hem ozet icin tek kaynaktan kullanma.

## Uygulama Guncelleme Plani (UI/API)
- API katmaninda model aliaslari korunacak (`invoiceCode`, `paymentFormDescription` vb.).
- Frontend tarafinda minimum kirilimla gecis icin once API source degistirilecek.
- Sonra adim adim:
  - Ozet hesap endpointi,
  - Detay liste endpointi,
  - Mutabakat ekrani endpointi
  `dist2k` odakli hale getirilecek.

## Kontrol Listesi
- [x] Dist2k sema + tablolar
- [x] Dbo -> Dist2k senkron
- [x] Import sonrasi otomatik rebuild
- [x] Delete endpointleri sonrasi otomatik rebuild
- [x] Position API query migration
- [x] Position detail API query migration
- [x] Mutabakat entegrasyon testi
- [x] Dbo fact tablolari devreden cikarma
