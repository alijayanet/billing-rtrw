package com.alijaya.customer.data.api

import com.alijaya.customer.data.model.*
import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    @GET("api/customer/config")
    suspend fun getServerConfig(): Response<ApiResponse<ServerConfig>>

    @GET("api/customer/ping")
    suspend fun ping(): Response<ApiResponse<Unit>>

    @POST("api/customer/auth/login")
    suspend fun login(
        @Body body: Map<String, String>
    ): Response<ApiResponse<Customer>>

    @GET("api/customer/dashboard")
    suspend fun getDashboard(): Response<ApiResponse<DashboardData>>

    @GET("api/customer/invoices")
    suspend fun getInvoices(): Response<ApiResponse<List<Invoice>>>

    @GET("api/customer/invoices/{id}")
    suspend fun getInvoiceDetail(
        @Path("id") id: Int
    ): Response<ApiResponse<Invoice>>

    @POST("api/customer/invoices/{id}/pay")
    suspend fun createPayment(
        @Path("id") id: Int,
        @Body body: Map<String, String>
    ): Response<ApiResponse<PaymentResponse>>

    @GET("api/customer/invoices/{id}/check-status")
    suspend fun checkPaymentStatus(
        @Path("id") id: Int
    ): Response<ApiResponse<PaymentStatusResponse>>

    @GET("api/customer/wifi")
    suspend fun getWifiInfo(): Response<ApiResponse<OntInfo>>

    @POST("api/customer/wifi/change-ssid")
    suspend fun changeWifiSsid(
        @Body body: Map<String, String>
    ): Response<ApiResponse<Unit>>

    @POST("api/customer/wifi/change-password")
    suspend fun changeWifiPassword(
        @Body body: Map<String, String>
    ): Response<ApiResponse<Unit>>

    @POST("api/customer/wifi/reboot")
    suspend fun rebootModem(): Response<ApiResponse<Unit>>

    @GET("api/customer/vouchers")
    suspend fun getVouchers(): Response<ApiResponse<List<VoucherPackage>>>

    @GET("api/customer/tickets")
    suspend fun getTickets(): Response<ApiResponse<List<Ticket>>>

    @POST("api/customer/tickets/create")
    suspend fun createTicket(
        @Body body: Map<String, String>
    ): Response<ApiResponse<Unit>>
}
