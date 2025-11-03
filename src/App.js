import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import * as XLSX from "xlsx";
import Fuse from "fuse.js";

// --- Tipos y Utils ---
/**
 * @typedef {Object<string, string|number>} Row
 * @typedef {'asc'|'desc'} SortDirection
 * @typedef {'contiene'|'='} FilterMode
 * @typedef {{ mode: FilterMode, value?: string, min?: number, max?: number }} FilterConfig
 * @typedef {Object<string, FilterConfig>} Filters
 * @typedef {import('xlsx').WorkBook} WorkBook
 * @typedef {{ company: string, totalValue: number, totalWeight: number, isFiltered: boolean }} CompanyAggregates
 * * @typedef {object} NumericStats
 * @property {string} column
 * @property {boolean} isNumeric
 * @property {number} totalCount
 * @property {number} sum
 * @property {number} avg
 * @property {number} min
 * @property {number} max
 * @property {number} median
 * * @typedef {object} CategoricalStats
 * @property {string} column
 * @property {boolean} isNumeric
 * @property {number} totalCount
 * @property {number} uniqueCount
 * @property {{ value: string, count: number }[]} topValues
 * * @typedef {NumericStats | CategoricalStats} ColumnStats
 */

function downloadCSV(filename, rows) {
    if (!rows?.length) return;
    const header = Object.keys(rows[0]);
    const escape = (v) => {
        if (v === null || v === undefined || v === "") return "";
        const s = String(v).replaceAll('"', '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
    };
    const csvRows = rows.map(r => header.map(k => escape(r[k])).join(","));
    const csvContent = [header.map(escape).join(","), ...csvRows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

const isValueNumeric = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)));
const isColumnMostlyNumeric = (data, key) => {
    const sample = data.slice(0, 200); 
    if (!sample.length) return false;
    const numericCount = sample.filter(r => isValueNumeric(r[key])).length;
    return numericCount / sample.length > 0.7; 
};


// --- Componente principal ---
export default function ExcelSearchApp() {
    // [ESTADOS Y REFS]
    const [rawData, setRawData] = useState([]);
    const [columns, setColumns] = useState([]);
    const [sheetNames, setSheetNames] = useState([]);
    const [activeSheet, setActiveSheet] = useState("");
    const workbookRef = useRef(null); 
    const [query, setQuery] = useState("");
    const [selectedKeys, setSelectedKeys] = useState([]);
    const [filters, setFilters] = useState({});
    const [sortKey, setSortKey] = useState("");
    const [sortDir, setSortDir] = useState("asc");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(50);
    const fuseRef = useRef(null);

    /** @type {[CompanyAggregates | null, React.Dispatch<React.SetStateAction<CompanyAggregates | null>>]} */
    const [selectedCompanyData, setSelectedCompanyData] = useState(null);

    /** @type {[ColumnStats | null, React.Dispatch<React.SetStateAction<ColumnStats | null>>]} */
    const [selectedColumnStats, setSelectedColumnStats] = useState(null); // NUEVO ESTADO PARA ESTADÍSTICAS

    // [DEPENDENCIAS OPTIMIZADAS]
    const numericColumns = useMemo(() => {
        if (!rawData.length) return new Set();
        const numCols = columns.filter(col => isColumnMostlyNumeric(rawData, col));
        return new Set(numCols);
    }, [rawData, columns]);

    // [LÓGICA DE AGREGACIÓN DE EMPRESAS]
    /**
     * @type {(companyName: string, dataSet: Row[]) => Omit<CompanyAggregates, 'isFiltered'>}
     */
    const getCompanyAggregates = useCallback((companyName, dataSet) => {
        let totalValue = 0;
        let totalWeight = 0;
        
        dataSet.forEach(row => {
            const consignee = String(row['Consignatario'] ?? "").trim();
            const shipper = String(row['Expedidor'] ?? "").trim();
            
            if (consignee === companyName || shipper === companyName) {
                const value = Number(row['Valor (USD)']);
                if (!isNaN(value)) {
                    totalValue += value;
                }
                
                const weight = Number(row['Weight (KG)']);
                if (!isNaN(weight)) {
                    totalWeight += weight;
                }
            }
        });
        
        return {
            company: companyName,
            totalValue,
            totalWeight,
        };
    }, []);

    // [LÓGICA DE ESTADÍSTICAS DE COLUMNA - NUEVA]
    /**
     * @type {(colName: string, dataSet: Row[]) => ColumnStats | null}
     */
    const getVisibleColumnStats = useCallback((colName, dataSet) => {
        if (!dataSet || dataSet.length === 0) return null;
        
        const isNum = numericColumns.has(colName);
        const filteredValues = dataSet.map(row => row[colName]).filter(v => v !== null && v !== undefined && v !== "");
        const totalCount = filteredValues.length;
        
        if (totalCount === 0) return null;

        if (isNum) {
            const numbers = filteredValues
                .map(v => Number(v))
                .filter(n => !isNaN(n));
            
            if (numbers.length === 0) return null;

            const sum = numbers.reduce((acc, curr) => acc + curr, 0);
            const avg = sum / numbers.length;
            const min = Math.min(...numbers);
            const max = Math.max(...numbers);

            // Cálculo de Mediana
            const sortedNumbers = [...numbers].sort((a, b) => a - b);
            let median;
            if (sortedNumbers.length % 2 === 0) {
                const mid1 = sortedNumbers.length / 2;
                median = (sortedNumbers[mid1 - 1] + sortedNumbers[mid1]) / 2;
            } else {
                median = sortedNumbers[Math.floor(sortedNumbers.length / 2)];
            }

            return {
                column: colName,
                isNumeric: true,
                totalCount: numbers.length,
                sum,
                avg,
                min,
                max,
                median,
            };
        } else {
            const counts = {};
            filteredValues.forEach(v => {
                const key = String(v).trim();
                counts[key] = (counts[key] || 0) + 1;
            });

            const sortedCounts = Object.entries(counts)
                .sort(([, countA], [, countB]) => countB - countA);

            const topValues = sortedCounts.slice(0, 5).map(([value, count]) => ({ value, count }));
            const uniqueCount = sortedCounts.length;

            return {
                column: colName,
                isNumeric: false,
                totalCount,
                uniqueCount,
                topValues,
            };
        }
    }, [numericColumns]);


    // [PIPELINE DE DATOS - FILTROS Y BÚSQUEDA]
    const applyDeterministicFilters = useCallback((rows) => {
        const fkeys = Object.keys(filters || {}).filter(k => 
            filters[k] && (filters[k].value !== undefined && filters[k].value !== "" || filters[k].min !== undefined || filters[k].max !== undefined)
        );
        if (!fkeys.length) return rows;
        return rows.filter(r => {
            return fkeys.every(col => {
                const cfg = filters[col] || {};
                const cell = r[col];
                if (numericColumns.has(col)) { 
                    const num = Number(cell);
                    if (isNaN(num)) return false; 
                    const min = cfg.min !== undefined ? Number(cfg.min) : undefined;
                    const max = cfg.max !== undefined ? Number(cfg.max) : undefined;
                    if (min !== undefined && num < min) return false;
                    if (max !== undefined && num > max) return false;
                    return true;
                }
                const val = String(cfg.value ?? "").trim().toLowerCase();
                if (!val) return true;
                const cellStr = String(cell ?? "").toLowerCase();
                if (cfg.mode === "=") return cellStr === val;
                return cellStr.includes(val);
            });
        });
    }, [filters, numericColumns]);

    const processed = useMemo(() => {
        let rows = rawData;
        rows = applyDeterministicFilters(rows);
        
        if (query && fuseRef.current) {
            try {
                rows = fuseRef.current.search(query).map(res => res.item);
            } catch (e) {
                console.error("Error al ejecutar Fuse search.", e);
            }
        }
        
        if (sortKey && columns.includes(sortKey)) {
            const dir = sortDir === "asc" ? 1 : -1;
            rows = [...rows].sort((a, b) => {
                const va = a[sortKey];
                const vb = b[sortKey];
                
                if (numericColumns.has(sortKey)) {
                    const numA = Number(va);
                    const numB = Number(vb);
                    if (isNaN(numA) || isNaN(numB)) {
                        if (isNaN(numA) && isNaN(numB)) return 0;
                        return isNaN(numA) ? 1 * dir : -1 * dir;
                    }
                    return (numA - numB) * dir;
                }
                
                return String(va ?? "").localeCompare(String(vb ?? "")) * dir;
            });
        }
        
        return rows;
    }, [rawData, filters, query, sortKey, sortDir, columns, applyDeterministicFilters, numericColumns]);


    // [HANDLER DE CLICK EN ENCABEZADO DE COLUMNA - NUEVO Y COMBINADO]
    const handleColumnHeaderClick = (colName) => {
        // 1. Lógica de Ordenamiento
        if (sortKey === colName) {
            setSortDir(sortDir === "asc" ? "desc" : "asc");
        } else {
            setSortKey(colName);
            setSortDir("asc");
        }
        
        // 2. Lógica de Estadísticas
        const stats = getVisibleColumnStats(colName, processed);
        setSelectedColumnStats(stats);
    };

    // [HANDLER DE CLICK EN EMPRESA - MANTENIDO DINÁMICO]
    const handleCompanyClick = (companyName) => {
        if (!companyName || companyName.trim() === "") return;
        
        // Determinar si hay filtros activos
        const isFiltered = rawData.length !== processed.length || query.trim() !== "";
        
        // Elegir el conjunto de datos a analizar
        const dataToAnalyze = isFiltered ? processed : rawData;
        
        // Obtener los agregados
        const aggregates = getCompanyAggregates(companyName, dataToAnalyze);
        
        setSelectedCompanyData({
            ...aggregates,
            isFiltered: isFiltered
        });
    };

    // [HANDLERS DE CARGA Y UX]
    const loadSheetData = useCallback((wb, sheetName) => {
        const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });
        const cols = Object.keys(json[0] || {});
        setRawData(json);
        setColumns(cols);
        setSelectedKeys(cols); 
        setFilters({}); 
        setQuery("");
        setPage(1);
        setSelectedColumnStats(null); // Limpiar stats al cargar nuevos datos
    }, []);

    const handleFile = async (file) => {
        try {
            const data = await file.arrayBuffer();
            const wb = XLSX.read(data, { type: "array" });
            workbookRef.current = wb; 
            const sheets = wb.SheetNames;
            const sheet = sheets[0];
            setSheetNames(sheets);
            setActiveSheet(sheet);
            loadSheetData(wb, sheet);
        } catch (error) {
            console.error("Error al cargar el archivo:", error);
            alert("Error al procesar el archivo. Asegúrate de que sea un archivo .xlsx, .xls o .csv válido.");
            setRawData([]);
            setColumns([]);
            setSheetNames([]);
            setActiveSheet("");
            workbookRef.current = null;
        }
    };

    const handleSheetChange = (name) => {
        const wb = workbookRef.current;
        if (wb && wb.SheetNames.includes(name)) {
            setActiveSheet(name);
            loadSheetData(wb, name); 
        } else if (wb) {
            setActiveSheet(name);
        } else {
            setActiveSheet(name);
        }
    };

    useEffect(() => {
        if (!rawData.length || !selectedKeys.length) {
            fuseRef.current = null;
            return;
        }
        const fuseOptions = {
            keys: selectedKeys,
            threshold: 0.35,
            ignoreLocation: true,
            minMatchCharLength: 2,
            useExtendedSearch: false,
            shouldSort: false,
        };
        fuseRef.current = new Fuse(rawData, fuseOptions);
    }, [rawData, selectedKeys]);


    const total = processed.length;
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const pageClamped = Math.min(Math.max(1, page), maxPage); 
    const start = (pageClamped - 1) * pageSize;
    const visible = processed.slice(start, start + pageSize);

    const toggleKey = (k) => {
        setSelectedKeys(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k]);
        setPage(1);
    };

    const setFilterValue = (col, patch) => {
        setFilters(prev => ({ 
            ...prev, 
            [col]: { 
                mode: "contiene", 
                value: "", 
                ...prev[col], 
                ...patch 
            } 
        }));
        setPage(1);
    };

    const clearAll = () => {
        setQuery("");
        setFilters({});
        setSortKey("");
        setSortDir("asc");
        setPage(1);
        setSelectedColumnStats(null); // Limpiar stats al resetear filtros
    };

    // --- Renderizado y Estilos ---

    const backgroundStyle = {
        backgroundColor: '#e0f7fa',
    };

    return (
        <div style={backgroundStyle} className="min-h-screen w-full text-neutral-900 p-6">
            <div className="max-w-[1400px] mx-auto grid lg:grid-cols-[2fr_1fr] xl:grid-cols-[3fr_1fr] gap-6">

                {/* CONTENIDO PRINCIPAL (Tabla, Filtros, Búsqueda) */}
                <div className={`${selectedColumnStats ? 'lg:col-span-1' : 'lg:col-span-2'} backdrop-blur-sm bg-white/90 rounded-2xl shadow-2xl p-6`}>
                    <header className="mb-6">
                        <h1 className="text-3xl font-bold">Buscador de Excel en tu Navegador</h1>
                        <p className="text-sm mt-1">Sube un archivo, busca con coincidencia difusa, filtra, ordena y exporta. Todo localmente.</p>
                    </header>

                    {/* ZONA DE CARGA Y BÚSQUEDA GLOBAL */}
                    <div className="grid gap-4 md:grid-cols-3">
                        <div className="col-span-2 bg-white rounded-2xl shadow p-4">
                            <label className="block text-sm font-medium mb-2">Archivo (.xlsx o .csv)</label>
                            <FileDrop onFile={handleFile} />
                            {sheetNames.length > 1 && (
                                <div className="mt-3">
                                    <label className="text-xs font-semibold mr-2">Hoja activa:</label>
                                    <select
                                        value={activeSheet}
                                        onChange={(e) => handleSheetChange(e.target.value)}
                                        className="border rounded-lg px-2 py-1 text-sm"
                                        disabled={!workbookRef.current}
                                    >
                                        {sheetNames.map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                </div>
                            )}
                        </div>

                        <div className="bg-white rounded-2xl shadow p-4">
                            <label className="block text-sm font-medium mb-2">Búsqueda global (difusa)</label>
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                                placeholder="Escribe aquí para buscar en las columnas seleccionadas..."
                                className="w-full border rounded-lg px-3 py-2 focus:outline-none"
                                disabled={!rawData.length}
                            />
                            <div className="mt-3">
                                <p className="text-xs font-semibold mb-1">Columnas incluidas en la búsqueda difusa</p>
                                <div className="flex flex-wrap gap-2 max-h-32 overflow-auto border p-1 rounded-lg">
                                    {columns.map(k => (
                                        <button
                                            key={k}
                                            onClick={() => toggleKey(k)}
                                            className={`text-xs px-2 py-1 rounded-full border transition-colors ${selectedKeys.includes(k) ? "bg-indigo-600 text-white border-indigo-600" : "bg-white hover:bg-neutral-100"}`}
                                            disabled={!rawData.length}
                                        >{k}</button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* PANEL DE FILTROS POR COLUMNA */}
                    {rawData.length > 0 && (
                        <div className="mt-6 bg-white rounded-2xl shadow p-4">
                            <div className="flex items-center justify-between gap-4 flex-wrap pb-4 border-b">
                                <div className="flex items-center gap-3">
                                    <button onClick={clearAll} className="text-sm border rounded-lg px-3 py-2 hover:bg-red-50 hover:text-red-700 transition-colors">Limpiar Filtros/Búsqueda</button>
                                    <button 
                                        onClick={() => downloadCSV("resultados_filtrados.csv", processed)} 
                                        className="text-sm border rounded-lg px-3 py-2 bg-green-500 text-white hover:bg-green-600 transition-colors font-medium"
                                    >
                                        Descargar {total.toLocaleString()} Resultados
                                    </button>
                                    <button onClick={() => downloadCSV("pagina_actual.csv", visible)} className="text-sm border rounded-lg px-3 py-2 hover:bg-neutral-100 transition-colors">Descargar Página Actual</button>
                                </div>
                                <div className="flex items-center gap-2">
                                    <label className="text-sm font-medium whitespace-nowrap">Filas por página</label>
                                    <select 
                                        value={pageSize} 
                                        onChange={(e)=>{ setPageSize(Number(e.target.value)); setPage(1); }} 
                                        className="border rounded-lg px-2 py-1 text-sm"
                                    >
                                        {[25,50,100,250,500].map(n => <option key={n} value={n}>{n}</option>)}
                                    </select>
                                </div>
                            </div>

                            <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {columns.map(col => {
                                    const cfg = filters[col] || {};
                                    const isNum = numericColumns.has(col);
                                    
                                    return (
                                        <div key={col} className="border rounded-xl p-3 bg-neutral-50 shadow-sm">
                                            <div className="text-xs font-semibold mb-2 truncate text-indigo-700" title={col}>{col}</div>
                                            {isNum ? (
                                                <div className="flex gap-2 items-center">
                                                    <input 
                                                        type="number" 
                                                        value={cfg.min ?? ""} 
                                                        onChange={(e)=> setFilterValue(col, { min: e.target.value === "" ? undefined : Number(e.target.value), value: undefined, mode: undefined })} 
                                                        placeholder="Mínimo" 
                                                        className="w-1/2 border rounded-lg px-2 py-1 text-sm" 
                                                    />
                                                    <input 
                                                        type="number" 
                                                        value={cfg.max ?? ""} 
                                                        onChange={(e)=> setFilterValue(col, { max: e.target.value === "" ? undefined : Number(e.target.value), value: undefined, mode: undefined })} 
                                                        placeholder="Máximo" 
                                                        className="w-1/2 border rounded-lg px-2 py-1 text-sm" 
                                                    />
                                                </div>
                                            ) : (
                                                <div className="flex gap-2 items-center">
                                                    <select 
                                                        value={cfg.mode ?? "contiene"} 
                                                        onChange={(e)=> setFilterValue(col, { mode: /** @type {FilterMode} */ (e.target.value) })} 
                                                        className="border rounded-lg px-2 py-1 text-sm w-1/3"
                                                    >
                                                        <option value="contiene">Contiene</option>
                                                        <option value="=">Igual a</option>
                                                    </select>
                                                    <input 
                                                        type="text" 
                                                        value={cfg.value ?? ""} 
                                                        onChange={(e)=> setFilterValue(col, { value: e.target.value, min: undefined, max: undefined })} 
                                                        placeholder="Texto a buscar..." 
                                                        className="flex-1 border rounded-lg px-2 py-1 text-sm" 
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* TABLA DE RESULTADOS */}
                    {rawData.length > 0 && (
                        <div className="mt-6 bg-white rounded-2xl shadow overflow-hidden">
                            <div className="p-3 text-sm text-neutral-600 font-semibold">Mostrando {visible.length.toLocaleString()} de {total.toLocaleString()} resultados de {rawData.length.toLocaleString()} filas totales</div>
                            <div className="overflow-x-auto">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-neutral-100 sticky top-0 z-10 border-b-2 border-neutral-200">
                                        <tr>
                                            {columns.map(col => (
                                                <th key={col} className="text-left px-3 py-2 whitespace-nowrap">
                                                    <button
                                                        className="font-bold flex items-center gap-1 cursor-pointer hover:text-indigo-700 transition-colors"
                                                        onClick={() => handleColumnHeaderClick(col)} // LLAMADA AL NUEVO HANDLER
                                                        title="Clic para Ordenar y Ver Estadísticas de Columna"
                                                    >
                                                        {col} 
                                                        <span className="text-xs">
                                                            {sortKey === col ? (sortDir === "asc" ? "▲" : "▼") : ""}
                                                            {/* Ícono de Stats */}
                                                            {selectedColumnStats?.column === col && <span className="text-xs text-yellow-500"> ★</span>} 
                                                        </span>
                                                    </button>
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {visible.map((row, i) => (
                                            <tr key={start + i} className={i % 2 ? "bg-neutral-50" : "bg-white"}>
                                                {columns.map(col => (
                                                    <td key={col} className="px-3 py-2 border-b border-neutral-200 align-top max-w-[360px]">
                                                        { (col === 'Consignatario' || col === 'Expedidor') ? (
                                                            <button 
                                                                onClick={() => handleCompanyClick(String(row[col]))}
                                                                className="text-indigo-600 hover:text-indigo-800 underline transition-colors cursor-pointer"
                                                                title="Ver análisis de esta empresa"
                                                            >
                                                                {String(row[col] ?? "")}
                                                            </button>
                                                        ) : (
                                                            <div className="truncate" title={String(row[col] ?? "")}>
                                                                {String(row[col] ?? "")}
                                                            </div>
                                                        )}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Paginador */}
                            <div className="p-3 flex items-center justify-between text-sm border-t border-neutral-200">
                                <div>
                                    Página **{pageClamped}** de **{maxPage}**
                                </div>
                                <div className="flex gap-2">
                                    <button className="border rounded-lg px-3 py-1 hover:bg-neutral-100 transition-colors" onClick={() => setPage(1)} disabled={pageClamped === 1}>« Primero</button>
                                    <button className="border rounded-lg px-3 py-1 hover:bg-neutral-100 transition-colors" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={pageClamped === 1}>‹ Anterior</button>
                                    <button className="border rounded-lg px-3 py-1 hover:bg-neutral-100 transition-colors" onClick={() => setPage(p => Math.min(maxPage, p + 1))} disabled={pageClamped === maxPage}>Siguiente ›</button>
                                    <button className="border rounded-lg px-3 py-1 hover:bg-neutral-100 transition-colors" onClick={() => setPage(maxPage)} disabled={pageClamped === maxPage}>Último »</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* TIPS/FOOTER */}
                    <div className="mt-8 text-xs text-neutral-600">
                        <details>
                            <summary className="cursor-pointer font-semibold">
                                Acerca de esta Herramienta <strong className="font-bold">(Hecho por Vadir)</strong>
                            </summary>
                            <ul className="list-disc ml-5 mt-2 space-y-1">
                                <li>El proceso completo se ejecuta <strong className="font-bold">en tu navegador</strong>; ningún dato de tu archivo se sube a un servidor.</li>
                                <li>La <strong className="font-bold">búsqueda global</strong> es *difusa* (tolerante a errores); selecciona las columnas relevantes para obtener mejores resultados.</li>
                                <li>**¡NUEVO!** Haz clic en el encabezado de cualquier columna para ver su <strong className="font-bold">Análisis Rápido y Auditoría</strong> sobre los datos actualmente filtrados.</li>
                            </ul>
                        </details>
                    </div>
                </div>

                {/* PANEL LATERAL DE ESTADÍSTICAS (CONDICIONAL) */}
                {selectedColumnStats && (
                    <div className="lg:col-span-1">
                        <ColumnStatsPanel 
                            stats={selectedColumnStats} 
                            onClose={() => setSelectedColumnStats(null)} 
                        />
                    </div>
                )}
            </div>

            {/* MODAL DE DETALLE DE EMPRESA (FIXED) */}
            {selectedCompanyData && (
                <CompanyDetailModal 
                    data={selectedCompanyData} 
                    onClose={() => setSelectedCompanyData(null)} 
                />
            )}
        </div>
    );
}

// Componente FileDrop (Auxiliar)
function FileDrop({ onFile }) {
    const [drag, setDrag] = useState(false);
    const inputRef = useRef(null);
    return (
        <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                const f = e.dataTransfer.files?.[0];
                if (f) onFile(f);
            }}
            className={`border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-colors ${drag ? 'border-indigo-600 bg-indigo-50' : 'border-neutral-300 hover:bg-neutral-50'}`}
            onClick={() => inputRef.current?.click()}
        >
            <p className="text-sm text-neutral-600 mb-2">Arrastra tu archivo aquí o</p>
            <button type="button" className="border rounded-lg px-4 py-2 text-sm bg-indigo-500 text-white hover:bg-indigo-600 transition-colors shadow-md">
                Seleccionar archivo
            </button>
            <input 
                ref={inputRef} 
                type="file" 
                accept=".xlsx,.xls,.csv" 
                className="hidden" 
                onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                    e.target.value = '';
                }} 
            />
        </div>
    );
}


// --- 2. Componente: Modal de Detalle de Empresa ---
/**
 * @param {{ data: CompanyAggregates, onClose: () => void }} props
 */
function CompanyDetailModal({ data, onClose }) {
    const { company, totalValue, totalWeight, isFiltered } = data;

    // Función para formatear moneda y peso
    const formatCurrency = (num) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(num);
    const formatWeight = (num) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(num) + ' KG';
    const formatPricePerKg = (num) => new Intl.NumberFormat('en-US', { 
        style: 'currency', 
        currency: 'USD', 
        minimumFractionDigits: 2, 
        maximumFractionDigits: 4 
    }).format(num);

    let pricePerKg = 0;
    if (totalWeight > 0) {
        pricePerKg = totalValue / totalWeight;
    }

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 relative">
                <button 
                    onClick={onClose} 
                    className="absolute top-4 right-4 text-neutral-500 hover:text-neutral-900 text-2xl"
                >
                    &times;
                </button>

                <h2 className="text-xl font-bold text-indigo-700 mb-4 border-b pb-2">Análisis Global de Empresa</h2>
                <h3 className="text-2xl font-semibold mb-6">{company}</h3>

                {/* Resumen de Totales */}
                <div className="grid grid-cols-2 gap-4 text-center mb-6">
                    <div className="bg-indigo-50 p-4 rounded-lg">
                        <p className="text-sm font-medium text-indigo-700">Valor Total (USD)</p>
                        <p className="text-3xl font-bold text-indigo-900 mt-1">
                            {formatCurrency(totalValue)}
                        </p>
                    </div>
                    <div className="bg-green-50 p-4 rounded-lg">
                        <p className="text-sm font-medium text-green-700">Peso Total (KG)</p>
                        <p className="text-3xl font-bold text-green-900 mt-1">
                            {formatWeight(totalWeight)}
                        </p>
                    </div>
                </div>

                {/* SECCIÓN DEL VALOR POR KG */}
                <div className="mt-4 text-center p-3 bg-yellow-50 rounded-lg border border-yellow-200">
                    <h4 className="text-lg font-bold text-yellow-800 mb-1">
                        VALOR POR KILOGRAMO (PRECIO / KG)
                    </h4>
                    <p className="text-4xl font-extrabold text-yellow-900">
                        {formatPricePerKg(pricePerKg)}
                    </p>
                    <p className="text-xs text-neutral-600 mt-1">
                        Cálculo: {formatCurrency(totalValue)} / {totalWeight.toLocaleString()} KG
                    </p>
                </div>

                <p className="text-xs text-neutral-500 mt-4 text-center">
                    **Nota:** Este cálculo es **{isFiltered ? 'FILTRADO' : 'GLOBAL'}**. 
                    {isFiltered 
                        ? 'Refleja solo las filas visibles en la tabla principal (con filtros y búsqueda aplicados).'
                        : 'Refleja el 100% de los datos cargados.'
                    }
                </p>
            </div>
        </div>
    );
}

// --- 3. Nuevo Componente: Panel de Estadísticas de Columna ---
/**
 * @param {{ stats: ColumnStats, onClose: () => void }} props
 */
function ColumnStatsPanel({ stats, onClose }) {
    
    // Función de formato (para ser más legible)
    const formatNumber = (num, isCurrency = false) => {
        if (typeof num !== 'number') return '-';
        if (isCurrency) {
            return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(num);
        }
        return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(num);
    };

    const isNum = stats.isNumeric;
    const isCurrency = stats.column.includes('Valor (USD)'); // Heurística simple

    return (
        <div className="bg-white/90 rounded-2xl shadow-2xl p-6 h-full sticky top-6">
            <div className="flex justify-between items-start border-b pb-2 mb-4">
                <h2 className="text-xl font-bold text-indigo-700">
                    Análisis: <span className="font-extrabold block text-2xl text-neutral-900 truncate" title={stats.column}>{stats.column}</span>
                </h2>
                <button 
                    onClick={onClose} 
                    className="text-neutral-500 hover:text-neutral-900 text-2xl ml-4 p-1"
                >
                    &times;
                </button>
            </div>

            <div className="text-sm">
                <p className="mb-4 p-2 bg-neutral-100 rounded-lg font-medium">
                    Analizando **{stats.totalCount.toLocaleString()}** celdas visibles.
                </p>

                {isNum ? (
                    // Estadísticas Numéricas
                    <div className="space-y-3">
                        {
                            /** @type {NumericStats} */
                            (stats).avg !== undefined && (
                            <StatBox title="Promedio (Media)" value={formatNumber(/** @type {NumericStats} */ (stats).avg, isCurrency)} color="bg-indigo-50" />
                        )}
                        {
                            /** @type {NumericStats} */
                            (stats).median !== undefined && (
                            <StatBox title="Mediana (Valor Central)" value={formatNumber(/** @type {NumericStats} */ (stats).median, isCurrency)} color="bg-indigo-50" />
                        )}
                        {
                            /** @type {NumericStats} */
                            (stats).sum !== undefined && (
                            <StatBox title="Suma Total" value={formatNumber(/** @type {NumericStats} */ (stats).sum, isCurrency)} color="bg-green-50" />
                        )}
                        <div className="grid grid-cols-2 gap-3">
                            {
                                /** @type {NumericStats} */
                                (stats).min !== undefined && (
                                <StatBox title="Valor Mínimo" value={formatNumber(/** @type {NumericStats} */ (stats).min, isCurrency)} color="bg-red-50" size="text-lg" />
                            )}
                            {
                                /** @type {NumericStats} */
                                (stats).max !== undefined && (
                                <StatBox title="Valor Máximo" value={formatNumber(/** @type {NumericStats} */ (stats).max, isCurrency)} color="bg-red-50" size="text-lg" />
                            )}
                        </div>
                    </div>
                ) : (
                    // Estadísticas Categóricas
                    <div className="space-y-4">
                        <StatBox title="Valores Únicos" value={(/** @type {CategoricalStats} */ (stats)).uniqueCount.toLocaleString()} color="bg-yellow-50" size="text-2xl" />
                        
                        <h4 className="font-semibold text-neutral-700 border-b pb-1">Top 5 Valores Más Frecuentes:</h4>
                        <ul className="space-y-2">
                            {(/** @type {CategoricalStats} */ (stats)).topValues.map(({ value, count }) => (
                                <li key={value} className="flex justify-between items-center text-sm p-2 bg-neutral-50 rounded-lg border border-neutral-200">
                                    <span className="truncate max-w-[60%] font-medium" title={value}>{value || '[VACÍO]'}</span>
                                    <span className="text-neutral-600">
                                        {count.toLocaleString()} ({((count / stats.totalCount) * 100).toFixed(1)}%)
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
            <p className="text-xs text-neutral-500 mt-4 text-center">
                El análisis se basa en los resultados actualmente visibles (con filtros y búsqueda aplicados).
            </p>
        </div>
    );
}

/**
 * @param {{ title: string, value: string, color: string, size?: string }} props
 */
function StatBox({ title, value, color, size = "text-3xl" }) {
    return (
        <div className={`${color} p-3 rounded-lg border border-neutral-200`}>
            <p className="text-xs font-medium text-neutral-600 mb-1">{title}</p>
            <p className={`font-extrabold text-neutral-900 ${size}`}>{value}</p>
        </div>
    );
}