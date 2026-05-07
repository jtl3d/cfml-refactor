<cfset variables.userName = "alice">
<cfset variables.User_Name = "bob">

<cfif Variables.userName EQ "alice">
    <cfset variables.greeting = "hi alice">
</cfif>

<cfoutput>
    <p>username: #UserName#</p>
    <p>user_name: #user_name#</p>
    <p>greeting: #greeting#</p>
</cfoutput>
