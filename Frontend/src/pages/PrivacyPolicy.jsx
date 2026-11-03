import { useBranding } from "../branding/BrandingProvider";
import React from 'react';
import '../styles/PrivacyPolicy.css';

const PrivacyPolicy = () => {
  const { organisationName } = useBranding();
  return (
    <div className="privacy-policy-container">
      <div className="privacy-policy-content">
        <h1>Privacy Policy</h1>
        
        <div className="last-updated">
          <p><strong>Last Updated:</strong> January 2026</p>
        </div>

        <section>
          <h2>1. Introduction</h2>
          <p>
            Welcome to the {organisationName} Donation. We are committed to protecting your privacy and ensuring you have a positive experience on our platform. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our website and services.
          </p>
        </section>

        <section>
          <h2>2. Information We Collect</h2>
          <p>We may collect information about you in a variety of ways. The information we may collect on the site includes:</p>
          
          <h3>2.1 Personal Information</h3>
          <ul>
            <li>Full Name</li>
            <li>Email Address</li>
            <li>Phone Number</li>
            <li>Mailing Address</li>
            <li>Payment Information (credit/debit card details)</li>
            <li>Password</li>
          </ul>
        </section>

        <section>
          <h2>3. How We Use Your Information</h2>
          <p>We use the information we collect in the following ways:</p>
          <ul>
            <li>To process your donations and payments</li>
            <li>To send donation receipts and confirmation emails</li>
            <li>To communicate with you about your account and donation history</li>
            <li>To provide customer support and respond to inquiries</li>
            <li>To send promotional emails and updates (with your consent)</li>
            <li>To analyze usage patterns and improve our services</li>
            <li>To comply with legal obligations</li>
            <li>To prevent fraudulent activities and enhance security</li>
          </ul>
        </section>

        <section>
          <h2>4. Data Protection and Security</h2>
          <p>
            We implement appropriate technical and organizational measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction. This includes:
          </p>
          <ul>
            <li>SSL/TLS encryption for data transmission</li>
            <li>Secure password storage using industry-standard hashing</li>
            <li>Regular security audits and updates</li>
            <li>Restricted access to personal information</li>
            <li>Firewalls and intrusion detection systems</li>
          </ul>
        </section>

        <section>
          <h2>5. Sharing Your Information</h2>
          <p>
            We do not sell, trade, or rent your personal information to third parties. However, we may share your information in the following circumstances:
          </p>
          <ul>
            <li>With payment processors to process donations</li>
            <li>With email service providers for communication</li>
            <li>With legal authorities when required by law</li>
            <li>With service providers who assist us in operating our website</li>
            <li>In case of a business merger or acquisition</li>
          </ul>
        </section>

        <section>
          <h2>6. Cookies and Tracking Technologies</h2>
          <p>
            We use cookies to enhance your experience on our website. Cookies are small files stored on your browser that help us remember your preferences and track your usage. You can disable cookies in your browser settings, but this may affect the functionality of our website.
          </p>
        </section>

        <section>
          <h2>7. Your Rights and Choices</h2>
          <p>You have the following rights regarding your personal information:</p>
          <ul>
            <li>Right to access your personal data</li>
            <li>Right to correct inaccurate information</li>
            <li>Right to delete your account and data</li>
            <li>Right to opt-out of marketing communications</li>
            <li>Right to data portability</li>
            <li>Right to withdraw consent</li>
          </ul>
          <p>To exercise these rights, please contact us at privacy@oceanfoundation.org</p>
        </section>

        <section>
          <h2>8. Third-Party Links</h2>
          <p>
            Our website may contain links to third-party websites. We are not responsible for the privacy practices or content of these external sites. We encourage you to review the privacy policies of any third-party websites before providing your information.
          </p>
        </section>

        <section>
          <h2>9. Children's Privacy</h2>
          <p>
            Our services are not directed to individuals under the age of 13. We do not knowingly collect personal information from children under 13. If we become aware that we have collected such information, we will delete it promptly.
          </p>
        </section>

        <section>
          <h2>10. Data Retention</h2>
          <p>
            We retain your personal information for as long as necessary to fulfill the purposes outlined in this privacy policy. Upon deletion of your account, we will retain your information only as required by law or for legitimate business purposes.
          </p>
        </section>

        <section>
          <h2>11. International Data Transfers</h2>
          <p>
            Your information may be transferred to, stored in, and processed in countries other than your country of residence. By using our services, you consent to such transfers subject to appropriate safeguards.
          </p>
        </section>

        <section>
          <h2>12. Updates to This Privacy Policy</h2>
          <p>
            We may update this Privacy Policy periodically to reflect changes in our practices or for other operational, legal, or regulatory reasons. We will notify you of significant changes by posting the updated policy on our website with a new "Last Updated" date.
          </p>
        </section>

        <section>
          <h2>13. Contact Us</h2>
          <p>
            If you have questions, concerns, or requests regarding this Privacy Policy or our privacy practices, please contact us at:
          </p>
          <div className="contact-info">
            <p><strong>Ocean Foundation</strong></p>
            <p>Email: privacy@oceanfoundation.org</p>
            <p>Address: [Your Address]</p>
            <p>Phone: [Your Phone Number]</p>
          </div>
        </section>
      </div>
    </div>
  );
};

export default PrivacyPolicy;
