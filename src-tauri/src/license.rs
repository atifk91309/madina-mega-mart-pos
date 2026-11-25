use sha2::{Sha256, Digest};
use chrono::NaiveDate;

const SECRET: &str = "MADINA-MART-2026-SECRET-KEY";

// PC ka pakka ID - Windows ka MachineGuid
pub fn get_machine_id() -> String {
    match machine_uid::get() {
        Ok(id) => {
            // Jaise: A1B2-C3D4-E5F6
            let clean: String = id.chars().filter(|c| c.is_alphanumeric()).collect();
            let upper = clean.to_uppercase();
            format!("{}-{}-{}", &upper[0..4], &upper[4..8], &upper[8..12])
        },
        Err(_) => "UNKNOWN-PC-0000".to_string()
    }
}

// Tum generator se key banaoge
// expiry = "20271231" (YYYYMMDD)
pub fn make_license(machine_id: &str, expiry: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{}|{}", machine_id, expiry, SECRET));
    let hash = format!("{:X}", hasher.finalize());
    format!("MAD-{}-{}-{}", &machine_id[0..4], &hash[0..4], expiry)
}

// Client ke app me check hoga
pub fn check_license(key: &str, machine_id: &str) -> Result<String, String> {
    // Format: MAD-AB12-3F9K-20271231
    let parts: Vec<&str> = key.trim().split("-").collect();
    if parts.len() != 4 || parts[0] != "MAD" {
        return Err("Ghalat Key".to_string());
    }
    let expiry_str = parts[3];
    // Expiry check
    let expiry = NaiveDate::parse_from_str(expiry_str, "%Y%m%d")
        .map_err(|_| "Ghalat Date".to_string())?;
    let today = chrono::Local::now().date_naive();
    if expiry < today {
        return Err("License Expire Ho Gaya Hai".to_string());
    }
    // Key dobara bana ke match karo
    let expected = make_license(machine_id, expiry_str);
    if expected != key.trim().to_uppercase() {
        return Err("Ye Key Is PC Ki Nahi Hai".to_string());
    }
    Ok(expiry.format("%d-%m-%Y").to_string())
}