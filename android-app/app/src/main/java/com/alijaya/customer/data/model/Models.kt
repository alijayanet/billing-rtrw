package com.alijaya.customer.data.model

import com.google.gson.annotations.SerializedName

data class User(
    val id: Int,
    val name: String,
    val phone: String? = null,
    val username: String? = null,
    val role: String? = null
)

data class ApiResponse<T>(
    val success: Boolean,
    val message: String?,
    val token: String?,
    val role: String? = null,
    val data: T?,
    val customer: Customer? = null,
    val user: User? = null
)

data class ServerConfig(
    val appName: String,
    val companyHeader: String,
    val companyPhone: String,
    val companyEmail: String,
    val companyAddress: String,
    val operationalHours: String
)

data class Customer(
    val id: Int,
    val name: String,
    val phone: String,
    @SerializedName("pppoeUsername") val pppoeUsername: String?,
    val address: String?,
    val status: String,
    @SerializedName("isolateDay") val isolateDay: Int?,
    @SerializedName("installDate") val installDate: String?,
    @SerializedName("expiredAt") val expiredAt: String?,
    val balance: Double?
)

data class Package(
    val id: Int,
    val name: String,
    val price: Double,
    val speed: String?,
    @SerializedName("billingType") val billingType: String
)

data class OntInfo(
    val available: Boolean = true,
    val online: Boolean = true,
    val tr069Connected: Boolean = false,
    val model: String? = null,
    val serialNumber: String? = null,
    val softwareVersion: String? = null,
    val pppoeUsername: String? = null,
    val ip: String? = null,
    val rxPower: String? = null,
    val ssid: String? = null,
    val uptime: String? = null
)

data class BillingSummary(
    val unpaidCount: Int,
    val totalUnpaidAmount: Double,
    val latestUnpaidInvoice: Invoice?
)

data class IspInfo(
    val name: String? = null,
    val phone: String? = null,
    val address: String? = null,
    val tagline: String? = null
)

data class DashboardData(
    val profile: Customer,
    @SerializedName("package") val packageInfo: Package?,
    val billing: BillingSummary,
    val ont: OntInfo?,
    val isp: IspInfo? = null
)

data class Invoice(
    val id: Int,
    val invoiceNo: String,
    val periodMonth: Int,
    val periodYear: Int,
    val amount: Double,
    val status: String,
    val paidAt: String?,
    val paymentGateway: String?,
    val notes: String?,
    val createdAt: String?
)

data class PaymentResponse(
    val invoiceId: Int,
    val gateway: String,
    val method: String,
    val orderId: String,
    val paymentLink: String?,
    val qrUrl: String?
)

data class PaymentStatusResponse(
    val invoiceId: Int,
    val status: String,
    val isPaid: Boolean,
    val paidAt: String?,
    val paymentGateway: String?
)

data class VoucherPackage(
    val id: Int,
    val name: String,
    val profileName: String,
    val price: Double,
    val validity: String,
    val description: String?
)

data class Ticket(
    val id: Int,
    val ticketNo: String,
    val title: String,
    val description: String,
    val status: String,
    val priority: String,
    val createdAt: String,
    val updatedAt: String?
)
